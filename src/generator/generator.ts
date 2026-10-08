import * as OpenAPI from '@hey-api/openapi-ts';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, watch, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const DEFAULT_OUT_PATH = './src/openapi-client-generated';
const GENERATED_SDK_HASH_FILE = '.openapi-client-codegen.hash';

interface IGeneratorConfig {
    path: string;
    prefix?: string;
    operations?: string[];
}

interface IOverrideConfig {
    src: string;
    operations: string[];
}

let generatorMap: Record<string, string | IGeneratorConfig> = {};
let overridesMap: Record<string, string | IOverrideConfig> | null = null;
let overridesInverseMap: Record<string, string> | null = null;

/**
 * Watchful OpenAPI Client Generators
 */

export function createWatchfulOpenapiClientGenerators() {
    loadOpenapiConfig();
    return Object.entries(generatorMap).map(([openapiYamlPath, outConfig]) => createWatchfulOpenapiClientGenerator(openapiYamlPath, outConfig));
}

export function createWatchfulOpenapiClientGenerator(openapiYamlPath: string, outConfig: string | IGeneratorConfig) {
    const override = overridesMap?.[openapiYamlPath];
    const resolvedPath = resolveOverrideSrc(override) ?? openapiYamlPath;
    const operations = resolveOperations(outConfig, override);

    if (!existsSync(resolvedPath)) {
        console.log(`OpenAPI YAML file not found: ${resolvedPath}`);
        return null;
    }

    const generate = () => generateOpenapiClient(resolvedPath, outConfig, operations);

    const watcher = watch(resolvedPath);
    watcher.on('change', () => {
        // give the writes a moment to settle
        setTimeout(generate, 100);
    });

    generate();

    return {
        generate,
        close: () => watcher.close()
    };
}

/**
 * Generations functions
 */

export async function generateConfiguredOpenapiClients() {
    loadOpenapiConfig();
    for (const [openapiYamlPath, outConfig] of Object.entries(generatorMap)) {
        const override = overridesMap?.[openapiYamlPath];
        const resolvedPath = resolveOverrideSrc(override) ?? openapiYamlPath;
        const operations = resolveOperations(outConfig, override);
        await generateOpenapiClient(resolvedPath, outConfig, operations);
    }
}

let lastPendingGeneration: Promise<void> | null = null;

export async function generateOpenapiClient(openapiYamlPath: string, outConfig: string | IGeneratorConfig = DEFAULT_OUT_PATH, operations?: string[]) {
    const pendingGeneration = lastPendingGeneration ?? Promise.resolve();
    lastPendingGeneration = new Promise<void>(resolve => {
        pendingGeneration.then(() => generateOpenapiClientInternal(openapiYamlPath, outConfig, operations)).then(resolve);
    });
    return lastPendingGeneration;
}

async function generateOpenapiClientInternal(openapiYamlPath: string, outConfig: string | IGeneratorConfig, operations?: string[]) {
    const prefix = typeof outConfig === 'string' ? '' : (outConfig.prefix ?? '');
    const outPath = typeof outConfig === 'string' ? outConfig : outConfig.path;
    operations = operations ?? resolveGeneratorOperations(outConfig);

    const yaml = readFileSync(openapiYamlPath, 'utf8');
    const generationState = createGenerationState(yaml, prefix, operations);
    const copyDestination = overridesInverseMap?.[openapiYamlPath];
    let inputPath: string | undefined;

    const getInputPath = () => {
        inputPath ??= operations?.length ? filterSpecByOperations(openapiYamlPath, yaml, operations) : openapiYamlPath;
        return inputPath;
    };
    const getGenerationInputPath = () => alignJsonBodiesWithMultipart(getInputPath()) ?? getInputPath();

    if (isGeneratedSdkCurrent(outPath, generationState)) {
        if (copyDestination) {
            copyFileIfChanged(getInputPath(), copyDestination);
        }
        return;
    }

    try {
        try {
            await rm(outPath, { recursive: true });
        } catch {
            // ignore
        }

        await OpenAPI.createClient({
            input: getGenerationInputPath(),
            output: outPath,
            plugins: [
                {
                    name: '@hey-api/typescript', // preserve default output
                    $resolvers: { string: binaryUploadType }
                },
                {
                    name: '@hey-api/sdk',
                    operations: {
                        strategy: 'byTags',
                        methods: 'static',
                        containerName: `${prefix}{{name}}Api`
                    }
                },
                '@hey-api/schemas', // preserve default output
                {
                    name: '@hey-api/client-fetch', // default client
                    baseUrl: false
                }
            ]
        });

        writeGenerationState(outPath, generationState);

        if (copyDestination) {
            copyFileIfChanged(getInputPath(), copyDestination);
        }

        console.log(
            `[${new Date().toISOString()}] Generated client from ${openapiYamlPath} to ${outPath}/ (${operations?.length ? `${operations.length} operations` : 'all operations'})`
        );
    } catch (err) {
        console.error(`[${new Date().toISOString()}] Error generating client from ${openapiYamlPath}:`, err);
    }
}

/**
 * Binary fields also accept this package's upload helpers, which the runtime turns
 * into multipart file parts alongside native Blob and File values.
 */
const binaryUploadType: NonNullable<OpenAPI.Plugins.HeyApiTypeScript.Resolvers['string']> = ctx => {
    if (ctx.schema.format !== 'binary') return undefined;
    const uploadValue = ctx.plugin.symbolFactory.register('FileUploadValue', {
        external: '@zyno-io/openapi-client-codegen',
        kind: 'type'
    });
    return ctx.$.type.or(ctx.$.type('Blob'), ctx.$.type('File'), ctx.$.type(uploadValue));
};

interface IGenerationState {
    version: typeof GENERATION_STATE_VERSION;
    yamlHash: string;
    prefix: string;
    operations: string[];
}

// Bump when generator output changes for the same input, so existing SDKs regenerate.
const GENERATION_STATE_VERSION = 2;

function createGenerationState(yaml: string, prefix: string, operations: string[] | undefined): IGenerationState {
    return {
        version: GENERATION_STATE_VERSION,
        yamlHash: createHash('sha256').update(yaml).digest('hex'),
        prefix,
        operations: operations ?? []
    };
}

function isGeneratedSdkCurrent(outPath: string, state: IGenerationState): boolean {
    try {
        return readFileSync(join(outPath, GENERATED_SDK_HASH_FILE), 'utf8') === JSON.stringify(state);
    } catch {
        return false;
    }
}

function writeGenerationState(outPath: string, state: IGenerationState) {
    writeFileSync(join(outPath, GENERATED_SDK_HASH_FILE), JSON.stringify(state));
}

function copyFileIfChanged(source: string, destination: string) {
    try {
        if (readFileSync(source).equals(readFileSync(destination))) {
            return;
        }
    } catch {
        // The destination is missing or unreadable, so it needs to be refreshed.
    }

    copyFileSync(source, destination);
}

/**
 * Config Loaders
 */

function loadOpenapiConfig() {
    loadGeneratorMap();
    loadOverridesMap();
}

function loadGeneratorMap() {
    if (!existsSync('./openapi-specs.json')) {
        console.error('openapi-specs.json not found. Cannot generate OpenAPI client.');
        return;
    }

    try {
        const specsContent = readFileSync('./openapi-specs.json', 'utf8');
        generatorMap = JSON.parse(specsContent);
    } catch (e) {
        console.error('Failed to load openapi-specs.json:', e);
    }
}

function loadOverridesMap() {
    if (!existsSync('./openapi-specs.dev.json')) {
        return;
    }

    try {
        const overridesContent = readFileSync('./openapi-specs.dev.json', 'utf8');
        overridesMap = JSON.parse(overridesContent);
        overridesInverseMap = Object.fromEntries(Object.entries(overridesMap!).map(([k, v]) => [typeof v === 'string' ? v : v.src, k]));
    } catch (e) {
        console.error('Failed to load openapi-specs.dev.json:', e);
    }
}

function resolveOverrideSrc(override: string | IOverrideConfig | undefined): string | undefined {
    if (!override) return undefined;
    return typeof override === 'string' ? override : override.src;
}

function resolveOverrideOperations(override: string | IOverrideConfig | undefined): string[] | undefined {
    if (!override || typeof override === 'string') return undefined;
    return override.operations;
}

function resolveGeneratorOperations(config: string | IGeneratorConfig): string[] | undefined {
    if (typeof config === 'string') return undefined;
    return config.operations;
}

function resolveOperations(config: string | IGeneratorConfig, override: string | IOverrideConfig | undefined): string[] | undefined {
    return resolveOverrideOperations(override) ?? resolveGeneratorOperations(config);
}

/**
 * Spec Filtering
 */

function filterSpecByOperations(originalPath: string, content: string, operationIds: string[]): string {
    const isJson = originalPath.endsWith('.json');
    const spec = isJson ? JSON.parse(content) : parseYaml(content);
    const operationSet = new Set(operationIds);

    const filteredPaths: Record<string, Record<string, unknown>> = {};

    // Filter paths to only include operations matching the specified operationIds
    for (const [path, methods] of Object.entries(spec.paths ?? {})) {
        const methodsObj = methods as Record<string, unknown>;
        const filteredMethods: Record<string, unknown> = {};

        for (const [method, operation] of Object.entries(methodsObj)) {
            if (typeof operation !== 'object' || operation === null) {
                // Preserve path-level parameters, etc.
                filteredMethods[method] = operation;
                continue;
            }
            const op = operation as Record<string, unknown>;
            if (op.operationId && operationSet.has(op.operationId as string)) {
                filteredMethods[method] = operation;
            }
        }

        // Only include paths that have at least one matching operation
        const hasMethods = Object.keys(filteredMethods).some(k => ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace'].includes(k));
        if (hasMethods) {
            filteredPaths[path] = filteredMethods;
        }
    }

    // Collect all $ref references from the filtered paths
    const referencedSchemas = new Set<string>();
    collectRefs(filteredPaths, referencedSchemas);

    // Recursively resolve schema references
    const schemas = spec.components?.schemas as Record<string, unknown> | undefined;
    if (schemas) {
        let previousSize = 0;
        while (referencedSchemas.size > previousSize) {
            previousSize = referencedSchemas.size;
            for (const ref of referencedSchemas) {
                const schemaName = ref.replace('#/components/schemas/', '');
                if (schemas[schemaName]) {
                    collectRefs(schemas[schemaName], referencedSchemas);
                }
            }
        }
    }

    // Build filtered components
    const filteredComponents: Record<string, unknown> = {};
    if (spec.components) {
        for (const [key, value] of Object.entries(spec.components as Record<string, unknown>)) {
            if (key === 'schemas' && typeof value === 'object' && value !== null) {
                const filteredSchemas: Record<string, unknown> = {};
                for (const ref of referencedSchemas) {
                    const schemaName = ref.replace('#/components/schemas/', '');
                    if ((value as Record<string, unknown>)[schemaName]) {
                        filteredSchemas[schemaName] = (value as Record<string, unknown>)[schemaName];
                    }
                }
                if (Object.keys(filteredSchemas).length > 0) {
                    filteredComponents.schemas = filteredSchemas;
                }
            } else {
                // Preserve other component types (securitySchemes, parameters, etc.)
                filteredComponents[key] = value;
            }
        }
    }

    const filteredSpec = {
        ...spec,
        paths: filteredPaths,
        components: Object.keys(filteredComponents).length > 0 ? filteredComponents : undefined
    };

    return writeTempSpec('filtered', isJson, filteredSpec);
}

function writeTempSpec(name: string, isJson: boolean, spec: unknown): string {
    const tmpDir = mkdtempSync(join(tmpdir(), `openapi-${name}-`));
    const tmpPath = join(tmpDir, `${name}${isJson ? '.json' : '.yaml'}`);
    writeFileSync(tmpPath, isJson ? JSON.stringify(spec, null, 2) : stringifyYaml(spec), 'utf8');
    return tmpPath;
}

/**
 * hey-api types a request body from its JSON variant whenever one exists. A Deepkit
 * upload endpoint's JSON variant omits the binary fields, so those would be untyped.
 * Point the JSON variant at the multipart schema instead: the SDK still sends JSON, and
 * the runtime switches to multipart once a file value is present.
 *
 * Returns the path of an adjusted copy of the spec, or undefined if nothing changed.
 */
function alignJsonBodiesWithMultipart(specPath: string): string | undefined {
    const isJson = specPath.endsWith('.json');
    const content = readFileSync(specPath, 'utf8');
    const spec = isJson ? JSON.parse(content) : parseYaml(content);

    const requestBodies: unknown[] = Object.values(spec.components?.requestBodies ?? {});
    for (const methods of Object.values(spec.paths ?? {})) {
        for (const operation of Object.values((methods ?? {}) as Record<string, unknown>)) {
            if (typeof operation === 'object' && operation !== null) {
                requestBodies.push((operation as { requestBody?: unknown }).requestBody);
            }
        }
    }

    let changed = false;
    for (const requestBody of requestBodies) {
        const bodyContent = (requestBody as { content?: Record<string, { schema?: unknown }> } | undefined)?.content;
        const multipartSchema = bodyContent?.['multipart/form-data']?.schema;
        const json = bodyContent?.['application/json'];
        if (multipartSchema && json && !isDeepStrictEqual(json.schema, multipartSchema)) {
            json.schema = multipartSchema;
            changed = true;
        }
    }

    return changed ? writeTempSpec('aligned', isJson, spec) : undefined;
}

function collectRefs(obj: unknown, refs: Set<string>): void {
    if (typeof obj !== 'object' || obj === null) return;

    if (Array.isArray(obj)) {
        for (const item of obj) {
            collectRefs(item, refs);
        }
        return;
    }

    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
        if (key === '$ref' && typeof value === 'string' && value.startsWith('#/components/schemas/')) {
            refs.add(value);
        } else {
            collectRefs(value, refs);
        }
    }
}
