import * as OpenAPI from '@hey-api/openapi-ts';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
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

    if (isGeneratedSdkCurrent(outPath, generationState)) {
        if (copyDestination) {
            copyFileIfChanged(getInputPath(), copyDestination);
        }
        return;
    }

    let preparedPath: string | undefined;
    try {
        try {
            await rm(outPath, { recursive: true });
        } catch {
            // ignore
        }

        preparedPath = prepareSpecForGeneration(getInputPath());
        await OpenAPI.createClient({
            input: preparedPath ?? getInputPath(),
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
    } finally {
        if (preparedPath) rmSync(preparedPath, { force: true });
    }
}

/** Marks binary fields that are only ever sent in request bodies; see markUploadFields. */
const UPLOAD_FIELD_EXTENSION = 'x-openapi-client-codegen-upload';

/**
 * Upload fields also accept this package's upload helpers, which the runtime turns into
 * multipart file parts alongside native Blob and File values. Other binary schemas, such
 * as downloaded responses, keep hey-api's `Blob | File`.
 */
const binaryUploadType: NonNullable<OpenAPI.Plugins.HeyApiTypeScript.Resolvers['string']> = ctx => {
    if (ctx.schema.format !== 'binary' || !(ctx.schema as Record<string, unknown>)[UPLOAD_FIELD_EXTENSION]) return undefined;
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

    // Write to temp file
    const tmpDir = mkdtempSync(join(tmpdir(), 'openapi-filtered-'));
    const ext = isJson ? '.json' : '.yaml';
    const tmpPath = join(tmpDir, `filtered${ext}`);
    const output = isJson ? JSON.stringify(filteredSpec, null, 2) : stringifyYaml(filteredSpec);
    writeFileSync(tmpPath, output, 'utf8');

    return tmpPath;
}

/**
 * Adjusts a spec before hey-api reads it. Returns the path of an adjusted copy, written
 * beside the input so relative `$ref`s resolve the same way, or undefined if nothing changed.
 * The caller deletes the copy after generation.
 */
function prepareSpecForGeneration(specPath: string): string | undefined {
    const isJson = specPath.endsWith('.json');
    const spec = isJson ? JSON.parse(readFileSync(specPath, 'utf8')) : parseYaml(readFileSync(specPath, 'utf8'));

    const requestBodies = collectRequestBodies(spec);
    const aligned = alignJsonBodiesWithMultipart(requestBodies);
    const marked = markUploadFields(spec, requestBodies);
    if (!aligned && !marked) return undefined;

    const preparedPath = join(
        dirname(specPath),
        `.${basename(specPath, extname(specPath))}.codegen-${process.pid}-${Date.now()}${extname(specPath)}`
    );
    writeFileSync(preparedPath, isJson ? JSON.stringify(spec, null, 2) : stringifyYaml(spec), 'utf8');
    return preparedPath;
}

type MediaContent = Record<string, { schema?: unknown }>;
type SpecObject = Record<string, unknown>;

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

/** Request body content maps from operations and from `components.requestBodies`. */
function collectRequestBodies(spec: SpecObject): MediaContent[] {
    const bodies: unknown[] = Object.values((spec.components as SpecObject | undefined)?.requestBodies ?? {});
    for (const methods of Object.values((spec.paths ?? {}) as Record<string, SpecObject>)) {
        for (const method of HTTP_METHODS) {
            bodies.push((methods?.[method] as SpecObject | undefined)?.requestBody);
        }
    }
    return bodies.map(body => (body as { content?: MediaContent } | undefined)?.content).filter((content): content is MediaContent => !!content);
}

/**
 * hey-api types a request body from its JSON variant whenever one exists. A Deepkit
 * upload endpoint's JSON variant omits the binary fields, so those would be untyped.
 * Point the JSON variant at the multipart schema instead: the SDK still sends JSON, and
 * the runtime switches to multipart once a file value is present.
 */
function alignJsonBodiesWithMultipart(requestBodies: MediaContent[]): boolean {
    let changed = false;
    for (const content of requestBodies) {
        const multipartSchema = content['multipart/form-data']?.schema;
        const json = content['application/json'];
        if (multipartSchema && json && !isDeepStrictEqual(json.schema, multipartSchema)) {
            json.schema = multipartSchema;
            changed = true;
        }
    }
    return changed;
}

/**
 * Marks binary fields in request body schemas so binaryUploadType widens them. A
 * component schema is marked only if nothing outside request bodies references it, so
 * shared and response schemas keep their types.
 */
function markUploadFields(spec: SpecObject, requestBodies: MediaContent[]): boolean {
    const schemas = ((spec.components as SpecObject | undefined)?.schemas ?? {}) as Record<string, unknown>;
    const reachable = (roots: unknown[]) => {
        const refs = new Set<string>();
        for (const root of roots) collectRefs(root, refs);
        let size = -1;
        while (refs.size !== size) {
            size = refs.size;
            for (const ref of [...refs]) collectRefs(schemas[ref.replace('#/components/schemas/', '')], refs);
        }
        return refs;
    };

    const requestRoots = requestBodies.flatMap(content => Object.values(content).map(media => media.schema));
    const requestRefs = reachable(requestRoots);
    const otherRefs = reachable([
        withoutRequestBodies(spec.paths),
        withoutRequestBodies((spec.components as SpecObject | undefined)?.responses),
        (spec.components as SpecObject | undefined)?.parameters,
        (spec.components as SpecObject | undefined)?.headers
    ]);

    let changed = false;
    const mark = (node: unknown) => {
        if (typeof node !== 'object' || node === null) return;
        if (Array.isArray(node)) return node.forEach(mark);
        const obj = node as SpecObject;
        if (obj.format === 'binary' && obj.type === 'string') {
            obj[UPLOAD_FIELD_EXTENSION] = true;
            changed = true;
        } else if (obj.format === 'binary' && Array.isArray(obj.type) && obj.type.includes('string')) {
            // OpenAPI 3.1 nullable fields (`type: [string, 'null']`) are split into one schema
            // per type, which drops the marker. Spell them as the equivalent anyOf instead.
            obj.anyOf = obj.type.map(type => (type === 'string' ? { type, format: 'binary', [UPLOAD_FIELD_EXTENSION]: true } : { type }));
            delete obj.type;
            delete obj.format;
            changed = true;
            return;
        }
        for (const [key, value] of Object.entries(obj)) {
            if (key !== '$ref') mark(value);
        }
    };

    requestRoots.forEach(mark);
    for (const ref of requestRefs) {
        if (!otherRefs.has(ref)) mark(schemas[ref.replace('#/components/schemas/', '')]);
    }
    return changed;
}

/** A deep view of `node` without any `requestBody` members, for finding non-request references. */
function withoutRequestBodies(node: unknown): unknown {
    if (typeof node !== 'object' || node === null) return node;
    if (Array.isArray(node)) return node.map(withoutRequestBodies);
    return Object.fromEntries(
        Object.entries(node as SpecObject)
            .filter(([key]) => key !== 'requestBody')
            .map(([key, value]) => [key, withoutRequestBodies(value)])
    );
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
