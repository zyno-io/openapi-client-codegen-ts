import * as OpenAPI from '@hey-api/openapi-ts';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
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

        preparedPath = prepareSpecForGeneration(getInputPath(), dirname(openapiYamlPath));
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
        if (preparedPath) rmSync(dirname(preparedPath), { recursive: true, force: true });
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
 * Adjusts a spec before hey-api reads it. Returns the path of an adjusted copy in a temp
 * directory, or undefined if nothing changed. Relative external `$ref`s are rewritten
 * against `refBase` (the original spec's directory) so they resolve as they would have.
 */
function prepareSpecForGeneration(specPath: string, refBase: string): string | undefined {
    const isJson = specPath.endsWith('.json');
    // Round-trip through JSON so YAML aliases become separate objects: marking a request
    // schema must not also mark a response that aliased it.
    const parsed = isJson ? JSON.parse(readFileSync(specPath, 'utf8')) : parseYaml(readFileSync(specPath, 'utf8'));
    const spec = JSON.parse(JSON.stringify(parsed));

    // Mark first, so a JSON variant aligned to an inline multipart schema copies the markers.
    const marked = markUploadFields(spec);
    const aligned = alignJsonBodiesWithMultipart(spec);
    if (!aligned && !marked) return undefined;

    rebaseExternalRefs(spec, refBase);
    const tmpDir = mkdtempSync(join(tmpdir(), 'openapi-prepared-'));
    const preparedPath = join(tmpDir, `prepared${isJson ? '.json' : '.yaml'}`);
    writeFileSync(preparedPath, isJson ? JSON.stringify(spec, null, 2) : stringifyYaml(spec), 'utf8');
    return preparedPath;
}

type SpecObject = Record<string, unknown>;
type MediaContent = Record<string, { schema?: unknown }>;

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

const asObject = (value: unknown): SpecObject | undefined =>
    typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as SpecObject) : undefined;

function operationsOf(spec: SpecObject): SpecObject[] {
    const operations: SpecObject[] = [];
    for (const pathItem of Object.values(asObject(spec.paths) ?? {})) {
        for (const method of HTTP_METHODS) {
            const operation = asObject(asObject(pathItem)?.[method]);
            if (operation) operations.push(operation);
        }
    }
    return operations;
}

/** Request body content maps from operations and from `components.requestBodies`. */
function requestBodyContents(spec: SpecObject): MediaContent[] {
    const bodies = [
        ...operationsOf(spec).map(operation => operation.requestBody),
        ...Object.values(asObject(asObject(spec.components)?.requestBodies) ?? {})
    ];
    return bodies.map(body => asObject(asObject(body)?.content) as MediaContent | undefined).filter((content): content is MediaContent => !!content);
}

/**
 * hey-api types a request body from its JSON variant whenever one exists. A Deepkit
 * upload endpoint's JSON variant omits the binary fields, so those would be untyped.
 * Point the JSON variant at the multipart schema instead: the SDK still sends JSON, and
 * the runtime switches to multipart once a file value is present.
 */
function alignJsonBodiesWithMultipart(spec: SpecObject): boolean {
    let changed = false;
    for (const content of requestBodyContents(spec)) {
        const multipartSchema = content['multipart/form-data']?.schema;
        const json = content['application/json'];
        if (multipartSchema && json && !isDeepStrictEqual(json.schema, multipartSchema)) {
            json.schema = structuredClone(multipartSchema);
            changed = true;
        }
    }
    return changed;
}

const schemaRefName = (ref: unknown) =>
    typeof ref === 'string' && ref.startsWith('#/components/schemas/') ? ref.slice('#/components/schemas/'.length) : undefined;

/**
 * Marks the file fields of multipart request bodies so binaryUploadType widens them:
 * top-level binary properties and arrays of them, which is what the runtime sends as file
 * parts. A component schema is only marked if every reference to it anywhere in the spec
 * is the schema of a request body itself, so schemas used in responses, nested in other
 * schemas, or anywhere else keep their types.
 */
function markUploadFields(spec: SpecObject): boolean {
    const schemas = asObject(asObject(spec.components)?.schemas) ?? {};
    const contents = requestBodyContents(spec);

    const allRefs = countSchemaRefs(spec);
    const bodyRefs = new Map<string, number>();
    for (const content of contents) {
        for (const media of Object.values(content)) {
            const name = schemaRefName(asObject(media?.schema)?.$ref);
            if (name) bodyRefs.set(name, (bodyRefs.get(name) ?? 0) + 1);
        }
    }

    let changed = false;
    for (const content of contents) {
        const root = asObject(content['multipart/form-data']?.schema);
        const refName = schemaRefName(root?.$ref);
        if (refName && allRefs.get(refName) !== bodyRefs.get(refName)) continue;

        const properties = asObject(asObject(refName ? schemas[refName] : root)?.properties);
        for (const property of Object.values(properties ?? {})) {
            const field = asObject(property);
            const fileSchema = field?.type === 'array' ? asObject(field.items) : field;
            if (fileSchema && markBinarySchema(fileSchema)) changed = true;
        }
    }
    return changed;
}

/** Counts `$ref`s to each component schema, anywhere in the spec. */
function countSchemaRefs(node: unknown, counts = new Map<string, number>()): Map<string, number> {
    if (typeof node !== 'object' || node === null) return counts;
    for (const [key, value] of Object.entries(node as SpecObject)) {
        const name = key === '$ref' ? schemaRefName(value) : undefined;
        if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
        else countSchemaRefs(value, counts);
    }
    return counts;
}

/**
 * Marks `schema` in place as an upload field if it is a binary string. Nullable forms are
 * spelled as an anyOf whose string member carries the marker, because hey-api splits them
 * into one schema per type and drops extensions on the way.
 */
function markBinarySchema(schema: SpecObject): boolean {
    if (schema.format !== 'binary') return false;
    const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type];
    if (!types.includes('string')) return false;

    const fileSchema = { type: 'string', format: 'binary', [UPLOAD_FIELD_EXTENSION]: true };
    const { type: _type, format: _format, ...rest } = schema;

    if (Array.isArray(schema.type) && schema.type.length > 1) {
        // OpenAPI 3.1: type: [string, 'null']
        Object.assign(schema, { ...rest, anyOf: types.map(type => (type === 'string' ? fileSchema : { type })) });
        delete schema.type;
        delete schema.format;
    } else if (schema.nullable === true) {
        // OpenAPI 3.0: nullable: true, spelled with 3.0's form of a null type.
        const { nullable: _nullable, ...restWithoutNullable } = rest;
        Object.assign(schema, { ...restWithoutNullable, anyOf: [fileSchema, { nullable: true, enum: [null] }] });
        delete schema.type;
        delete schema.format;
        delete schema.nullable;
    } else {
        schema[UPLOAD_FIELD_EXTENSION] = true;
    }
    return true;
}

/** Rewrites relative external `$ref`s to absolute ones, so the spec can move directories. */
function rebaseExternalRefs(node: unknown, refBase: string): void {
    if (typeof node !== 'object' || node === null) return;
    if (Array.isArray(node)) return node.forEach(item => rebaseExternalRefs(item, refBase));

    const obj = node as SpecObject;
    for (const [key, value] of Object.entries(obj)) {
        if (key === '$ref' && typeof value === 'string' && !value.startsWith('#') && !/^[a-z][a-z0-9+.-]*:/i.test(value)) {
            // A file URL, so characters such as `#` in directory names stay part of the path.
            const fragmentStart = value.indexOf('#');
            const filePart = fragmentStart === -1 ? value : value.slice(0, fragmentStart);
            const fragment = fragmentStart === -1 ? '' : value.slice(fragmentStart);
            obj[key] = pathToFileURL(resolve(refBase, decodeURI(filePart))).href + fragment;
        } else {
            rebaseExternalRefs(value, refBase);
        }
    }
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
