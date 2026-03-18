import * as OpenAPI from '@hey-api/openapi-ts';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, watch, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const DEFAULT_OUT_PATH = './src/openapi-client-generated';

interface IGeneratorConfig {
    path: string;
    prefix?: string;
}

interface IOverrideConfig {
    src: string;
    operations: string[];
}

let generatedHash: string | null = null;
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
    const operations = resolveOverrideOperations(override);

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
        const operations = resolveOverrideOperations(override);
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

    const yaml = readFileSync(openapiYamlPath, 'utf8');
    const hashParts = [yaml, outPath, ...(operations ?? [])];
    const hash = createHash('sha256').update(hashParts.join('\0')).digest('hex');

    if (hash === generatedHash) {
        return;
    }

    generatedHash = hash;

    let inputPath = openapiYamlPath;

    if (operations?.length) {
        inputPath = filterSpecByOperations(openapiYamlPath, yaml, operations);
    }

    try {
        try {
            await rm(outPath, { recursive: true });
        } catch {
            // ignore
        }

        await OpenAPI.createClient({
            input: inputPath,
            output: outPath,
            plugins: [
                {
                    name: '@hey-api/typescript' // preserve default output
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

        if (overridesInverseMap?.[openapiYamlPath]) {
            const copySource = operations?.length ? inputPath : openapiYamlPath;
            copyFileSync(copySource, overridesInverseMap[openapiYamlPath]);
        }

        console.log(
            `[${new Date().toISOString()}] Generated client from ${openapiYamlPath} to ${outPath}/ (${operations?.length ? `${operations.length} operations` : 'all operations'})`
        );
    } catch (err) {
        console.error(`[${new Date().toISOString()}] Error generating client from ${openapiYamlPath}:`, err);
    }
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
