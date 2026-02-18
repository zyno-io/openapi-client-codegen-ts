import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, watch } from 'node:fs';
import { rm } from 'node:fs/promises';

import * as OpenAPI from '@hey-api/openapi-ts';

const DEFAULT_OUT_PATH = './src/openapi-client-generated';

interface IGeneratorConfig {
    path: string;
    prefix?: string;
}

let generatedHash: string | null = null;
let generatorMap: Record<string, string | IGeneratorConfig> = {};
let overridesMap: Record<string, string> | null = null;
let overridesInverseMap: Record<string, string> | null = null;

/**
 * Watchful OpenAPI Client Generators
 */

export function createWatchfulOpenapiClientGenerators() {
    loadOpenapiConfig();
    return Object.entries(generatorMap).map(([openapiYamlPath, outConfig]) => createWatchfulOpenapiClientGenerator(openapiYamlPath, outConfig));
}

export function createWatchfulOpenapiClientGenerator(openapiYamlPath: string, outConfig: string | IGeneratorConfig) {
    const resolvedPath = overridesMap?.[openapiYamlPath] ?? openapiYamlPath;

    if (!existsSync(resolvedPath)) {
        console.log(`OpenAPI YAML file not found: ${resolvedPath}`);
        return null;
    }

    const generate = () => generateOpenapiClient(resolvedPath, outConfig);

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
        const resolvedPath = overridesMap?.[openapiYamlPath] ?? openapiYamlPath;
        await generateOpenapiClient(resolvedPath, outConfig);
    }
}

let lastPendingGeneration: Promise<void> | null = null;

export async function generateOpenapiClient(openapiYamlPath: string, outConfig: string | IGeneratorConfig = DEFAULT_OUT_PATH) {
    const pendingGeneration = lastPendingGeneration ?? Promise.resolve();
    lastPendingGeneration = new Promise<void>(resolve => {
        pendingGeneration.then(() => generateOpenapiClientInternal(openapiYamlPath, outConfig)).then(resolve);
    });
    return lastPendingGeneration;
}

async function generateOpenapiClientInternal(openapiYamlPath: string, outConfig: string | IGeneratorConfig) {
    const prefix = typeof outConfig === 'string' ? '' : (outConfig.prefix ?? '');
    const outPath = typeof outConfig === 'string' ? outConfig : outConfig.path;

    const yaml = readFileSync(openapiYamlPath, 'utf8');
    const hash = createHash('sha256').update(yaml).digest('hex');

    if (hash === generatedHash) {
        return;
    }

    generatedHash = hash;

    try {
        try {
            await rm(outPath, { recursive: true });
        } catch {
            // ignore
        }

        await OpenAPI.createClient({
            input: openapiYamlPath,
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
            copyFileSync(openapiYamlPath, overridesInverseMap[openapiYamlPath]);
        }

        console.log(`[${new Date().toISOString()}] Generated client from ${openapiYamlPath} to ${outPath}/`);
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
        overridesInverseMap = Object.fromEntries(Object.entries(overridesMap!).map(([k, v]) => [v, k]));
    } catch (e) {
        console.error('Failed to load openapi-specs.dev.json:', e);
    }
}
