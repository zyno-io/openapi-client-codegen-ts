import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, before } from 'node:test';

import { configureOpenApiClient, type OpenApiClient } from '../../src/client/client.js';
import { FileUploadRequest, patchRequestOptionsForFileUpload, ReactNativeFileUploadRequest } from '../../src/client/uploads.js';
import { generateOpenapiClient } from '../../src/generator/generator.js';

const SPEC_PATH = path.join(import.meta.dirname, 'petstore.yaml');
const OUT_PATH = path.join(import.meta.dirname, 'generated');

// Clean up any prior generated files to ensure fresh generation
rmSync(OUT_PATH, { recursive: true, force: true });

describe('E2E: OpenAPI Client Codegen', () => {
    before(async () => {
        await generateOpenapiClient(SPEC_PATH, OUT_PATH);
    });

    it('generates expected SDK files', () => {
        assert.ok(existsSync(path.join(OUT_PATH, 'client.gen.ts')), 'client.gen.ts should exist');
        assert.ok(existsSync(path.join(OUT_PATH, 'sdk.gen.ts')), 'sdk.gen.ts should exist');
        assert.ok(existsSync(path.join(OUT_PATH, 'types.gen.ts')), 'types.gen.ts should exist');
    });

    it('records the YAML hash and skips unchanged SDK generation', async () => {
        const state = JSON.parse(readFileSync(path.join(OUT_PATH, '.openapi-client-codegen.hash'), 'utf8'));
        assert.equal(state.yamlHash, createHash('sha256').update(readFileSync(SPEC_PATH, 'utf8')).digest('hex'));

        const retainedFile = path.join(OUT_PATH, 'retained-on-skip');
        try {
            writeFileSync(retainedFile, 'keep');

            await generateOpenapiClient(SPEC_PATH, OUT_PATH);

            assert.ok(existsSync(retainedFile), 'unchanged input should not replace the SDK directory');
        } finally {
            rmSync(retainedFile, { force: true });
        }
    });

    it('produces a client assignable to OpenApiClient', async () => {
        const { client } = await import('./generated/client.gen.js');
        const typed: OpenApiClient = client;
        assert.ok(typed);
        assert.equal(typeof typed.request, 'function');
        assert.equal(typeof typed.get, 'function');
        assert.equal(typeof typed.post, 'function');
        assert.equal(typeof typed.delete, 'function');
        assert.equal(typeof typed.setConfig, 'function');
        assert.equal(typeof typed.getConfig, 'function');
        assert.equal(typeof typed.buildUrl, 'function');
        assert.ok(typed.interceptors);
        assert.ok(typed.interceptors.request);
        assert.ok(typed.interceptors.response);
        assert.ok(typed.interceptors.error);
    });

    it('works with configureOpenApiClient', async () => {
        const { client } = await import('./generated/client.gen.js');
        configureOpenApiClient(client, {
            headers: { 'X-Test': 'value' },
            onError: () => null,
            wrapper: async (options, request) => {
                return await request(options);
            }
        });
    });

    it('uses JSON when an optional multipart upload is omitted', () => {
        const sdk = readFileSync(path.join(OUT_PATH, 'sdk.gen.ts'), 'utf8');
        const createRequestMethod = sdk.slice(sdk.indexOf('public static createRequest'));

        assert.match(createRequestMethod, /'Content-Type': 'application\/json'/);
    });

    it('converts native Blob and File values to Deepkit multipart payloads', async () => {
        const blob = new Blob(['blob-content'], { type: 'text/plain' });
        const file = new File(['file-content'], 'file.txt', { type: 'text/plain' });
        const result = patchRequestOptionsForFileUpload({
            body: {
                title: 'Q4 Report',
                missingAttachment: null,
                blob,
                file
            },
            headers: {
                'content-type': 'application/json'
            },
            bodySerializer: () => 'serialized'
        });

        assert.ok(result.body instanceof FormData);
        assert.equal(result.headers['content-type'], null);
        assert.equal(result.bodySerializer, undefined);

        const formData = result.body as unknown as FormData;
        const blobPart = formData.get('blob');
        const filePart = formData.get('file');
        const payloadPart = formData.get('_payload');

        if (!(blobPart instanceof Blob)) assert.fail('Expected blob part to be a Blob');
        assert.equal(await blobPart.text(), 'blob-content');

        if (!(filePart instanceof File)) assert.fail('Expected file part to be a File');
        assert.equal(filePart.name, 'file.txt');
        assert.equal(await filePart.text(), 'file-content');

        if (typeof payloadPart !== 'string') assert.fail('Expected _payload part to be a string');
        assert.deepEqual(JSON.parse(payloadPart), {
            title: 'Q4 Report',
            missingAttachment: null
        });
    });

    it('types binary fields to accept the upload helpers', () => {
        const types = readFileSync(path.join(OUT_PATH, 'types.gen.ts'), 'utf8');

        assert.match(types, /import type \{ FileUploadValue \} from '@zyno-io\/openapi-client-codegen';/);
        assert.match(types, /photo\?: Blob \| File \| FileUploadValue;/);
        assert.match(types, /attachments\?: Array<Blob \| File \| FileUploadValue>;/);
    });

    it('marks OpenAPI 3.0 nullable upload fields, keeping the exported schema nullable', async () => {
        const types = readFileSync(path.join(OUT_PATH, 'types.gen.ts'), 'utf8');
        assert.match(types, /receipt\?: Blob \| File \| FileUploadValue \| null;/);

        const { CreateRequestRequestSchema } = await import('./generated/schemas.gen.js');
        assert.deepEqual(CreateRequestRequestSchema.properties.receipt.anyOf[1], { nullable: true, enum: [null] });
    });

    it('does not mark response fields that alias a request field in YAML', () => {
        const types = readFileSync(path.join(OUT_PATH, 'types.gen.ts'), 'utf8');
        assert.match(types, /scan\?: Blob \| File \| FileUploadValue;/);
        assert.match(types, /processed\?: Blob \| File;/);
    });

    it('keeps Blob | File for downloads, raw binary bodies, and schemas shared with responses', () => {
        const types = readFileSync(path.join(OUT_PATH, 'types.gen.ts'), 'utf8');

        assert.match(types.slice(types.indexOf('export type UploadRawData')), /^export type UploadRawData = \{\n {4}body: Blob \| File;/);
        // The multipart schema references into the JSON variant, so the JSON body is kept.
        assert.match(
            types.slice(types.indexOf('export type CreateNoteData')),
            /^export type CreateNoteData = \{\n {4}body: \{\n {8}title\?: string;\n {4}\};/
        );
        // A response references a field of an inline multipart schema by JSON pointer.
        assert.match(types.slice(types.indexOf('export type StampUpload = ')), /^export type StampUpload = \{\n {4}stamp\?: Blob \| File;/);
        // A response references one of its properties directly.
        assert.match(types.slice(types.indexOf('export type Thumbnail = ')), /^export type Thumbnail = \{\n {4}image\?: Blob \| File;/);
        // Also nested inside another request body, where the runtime can't upload it.
        assert.match(types.slice(types.indexOf('export type BatchItem = ')), /^export type BatchItem = \{\n {4}file\?: Blob \| File;/);
        // Referenced from a response property that happens to be named requestBody.
        assert.match(types.slice(types.indexOf('export type AuditedUpload = ')), /^export type AuditedUpload = \{\n {4}file\?: Blob \| File;/);

        assert.match(
            types.slice(types.indexOf('export type DownloadFileResponses')),
            /^export type DownloadFileResponses = \{[^}]*200: Blob \| File;/
        );
        assert.match(types.slice(types.indexOf('export type Document = ')), /^export type Document = \{\n {4}contents\?: Blob \| File;/);
    });

    it('accepts a JSON spec with a UTF-8 byte order mark', async () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'codegen-bom-'));
        const outPath = path.join(dir, 'generated');
        const spec = {
            openapi: '3.0.3',
            info: { title: 'BOM', version: '1' },
            paths: {},
            components: { schemas: { Pet: { type: 'object', properties: { name: { type: 'string' } } } } }
        };
        writeFileSync(path.join(dir, 'spec.json'), `\uFEFF${JSON.stringify(spec)}`);
        try {
            await generateOpenapiClient(path.join(dir, 'spec.json'), outPath);
            assert.match(readFileSync(path.join(outPath, 'types.gen.ts'), 'utf8'), /export type Pet = \{/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('accepts YAML that reuses an anchor more than 100 times', async () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'codegen-aliases-'));
        const outPath = path.join(dir, 'generated');
        const properties = Array.from({ length: 101 }, (_, i) => `        field${i}: *text`).join('\n');
        writeFileSync(
            path.join(dir, 'spec.yaml'),
            `openapi: 3.0.3
info:
  title: Aliases
  version: '1'
paths: {}
components:
  schemas:
    Text: &text
      type: string
    Wide:
      type: object
      properties:
${properties}
`
        );
        try {
            await generateOpenapiClient(path.join(dir, 'spec.yaml'), outPath);
            assert.match(readFileSync(path.join(outPath, 'types.gen.ts'), 'utf8'), /field100\?: string;/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('resolves relative $refs and leaves no adjusted spec behind', async () => {
        // The space and `#` check that relocated references still find the right directory.
        const specDir = path.join(import.meta.dirname, 'relative refs #1');
        const outPath = path.join(import.meta.dirname, 'generated-relative-refs');
        rmSync(outPath, { recursive: true, force: true });

        // Generation only needs to read the spec's directory.
        chmodSync(specDir, 0o555);
        try {
            await generateOpenapiClient(path.join(specDir, 'spec.yaml'), outPath);
        } finally {
            chmodSync(specDir, 0o755);
        }

        // The body is typed from the multipart schema; fields defined in other files aren't
        // marked as uploads, so they keep hey-api's Blob | File.
        const types = readFileSync(path.join(outPath, 'types.gen.ts'), 'utf8');
        assert.match(types, /export type UploadData = \{\n {4}body: UploadRequest;/);
        assert.match(types, /file\?: Blob \| File;/);
        assert.deepEqual(readdirSync(specDir).sort(), ['schemas.yaml', 'spec.yaml']);
    });

    it('marks OpenAPI 3.1 nullable binary upload fields, and only those', async () => {
        const outPath = path.join(import.meta.dirname, 'generated-openapi-31');
        rmSync(outPath, { recursive: true, force: true });

        await generateOpenapiClient(path.join(import.meta.dirname, 'openapi-31.yaml'), outPath);

        const types = readFileSync(path.join(outPath, 'types.gen.ts'), 'utf8');
        assert.match(types, /avatar\?: Blob \| File \| FileUploadValue \| null;/);
        assert.match(
            types.slice(types.indexOf('export type SetAvatarResponses')),
            /^export type SetAvatarResponses = \{[^}]*200: Blob \| File \| null;/
        );

        // Shared with a response declared in components.pathItems.
        assert.match(types.slice(types.indexOf('export type ExportFile = ')), /^export type ExportFile = \{\n {4}contents\?: Blob \| File;/);

        // Operations in components.pathItems, including 3.1 nullable arrays of files. A field
        // that already has anyOf alternatives is left as it is.
        const createGalleryData = types.slice(types.indexOf('export type CreateGalleryData'));
        assert.match(
            createGalleryData,
            /^export type CreateGalleryData = \{\n {4}body: \{\n {8}photos\?: Array<Blob \| File \| FileUploadValue> \| null;\n {8}cover\?: unknown \| null;/
        );
    });

    it('types a body from its multipart schema when the JSON variant omits file fields', () => {
        const types = readFileSync(path.join(OUT_PATH, 'types.gen.ts'), 'utf8');
        const sdk = readFileSync(path.join(OUT_PATH, 'sdk.gen.ts'), 'utf8');
        const sendMessageData = types.slice(types.indexOf('export type SendMessageData'));

        assert.match(sendMessageData, /^export type SendMessageData = \{\n {4}body: SendMessageRequest;/);
        // Still JSON by default; the runtime switches to multipart when files are present.
        assert.match(sdk.slice(sdk.indexOf('public static sendMessage')), /'Content-Type': 'application\/json'/);
    });

    it('sends an array of files as repeated parts, in order', async () => {
        const result = patchRequestOptionsForFileUpload({
            body: {
                textContent: 'hi',
                tags: ['a'],
                none: [],
                attachments: [new File(['one'], '1.txt', { type: 'text/plain' }), new FileUploadRequest(new Blob(['two'], { type: 'text/plain' }))]
            },
            headers: { 'content-type': 'application/json' }
        });

        assert.ok(result.body instanceof FormData);
        const formData = result.body as unknown as FormData;
        const parts = formData.getAll('attachments');
        assert.equal(parts.length, 2);
        if (!(parts[0] instanceof File) || !(parts[1] instanceof Blob)) assert.fail('Expected file parts');
        assert.equal(parts[0].name, '1.txt');
        assert.equal(await parts[0].text(), 'one');
        assert.equal(await parts[1].text(), 'two');

        const payloadPart = formData.get('_payload');
        if (typeof payloadPart !== 'string') assert.fail('Expected _payload part to be a string');
        assert.deepEqual(JSON.parse(payloadPart), { textContent: 'hi', tags: ['a'], none: [] });
    });

    it('keeps JSON when the only arrays hold no files', () => {
        const options = { body: { textContent: 'hi', attachments: [] }, headers: { 'content-type': 'application/json' } };
        assert.equal(patchRequestOptionsForFileUpload(options), options);
    });

    it('rejects arrays that mix files with other values', () => {
        assert.throws(
            () => patchRequestOptionsForFileUpload({ body: { attachments: [new Blob(['x']), 'not a file'] } }),
            /Field "attachments" mixes file uploads with other values/
        );
    });

    describe('ReactNativeFileUploadRequest', () => {
        // React Native's FormData keeps `{ uri, ... }` parts as given; Node's would stringify them.
        class ReactNativeLikeFormData {
            parts: [string, unknown][] = [];
            append(name: string, value: unknown) {
                this.parts.push([name, value]);
            }
        }

        // Mirrors expo/fetch, which serializes FormData in JS and needs `bytes()` for file parts.
        async function serializeLikeExpoFetch(form: ReactNativeLikeFormData) {
            const out: string[] = [];
            for (const [name, part] of form.parts) {
                if (typeof part === 'string') out.push(`${name}=${part}`);
                else if (typeof part === 'object' && part && 'bytes' in part) {
                    const file = part as unknown as { name: string; type: string; bytes(): Promise<Uint8Array> };
                    const { name: fileName, type } = file;
                    const bytes = await file.bytes();
                    out.push(`${name}[${fileName};${type}]=${Buffer.from(bytes).toString()}`);
                } else throw new Error('Unsupported FormDataPart implementation');
            }
            return out;
        }

        const originalFormData = globalThis.FormData;

        it('sends name, type, and bytes through a JavaScript FormData serializer', async () => {
            globalThis.FormData = ReactNativeLikeFormData as never;
            try {
                const photo = (contents: string, name: string) =>
                    new ReactNativeFileUploadRequest({
                        uri: `file:///${name}`,
                        name,
                        type: 'image/jpeg',
                        bytes: async () => new TextEncoder().encode(contents)
                    });
                const result = patchRequestOptionsForFileUpload({
                    body: { textContent: '', attachments: [photo('one', 'a.jpg'), photo('two', 'b.jpg')] }
                });

                assert.deepEqual(await serializeLikeExpoFetch(result.body as never), [
                    'attachments[a.jpg;image/jpeg]=one',
                    'attachments[b.jpg;image/jpeg]=two',
                    '_payload={"textContent":""}'
                ]);
            } finally {
                globalThis.FormData = originalFormData;
            }
        });

        it('keeps functions out of the properties React Native copies to native', () => {
            const upload = new ReactNativeFileUploadRequest({
                uri: 'file:///a.jpg',
                name: 'a.jpg',
                type: 'image/jpeg',
                bytes: async () => new Uint8Array()
            });
            assert.deepEqual(
                Object.values({ ...upload }).filter(v => typeof v === 'function'),
                []
            );
            assert.equal({ ...upload }.uri, 'file:///a.jpg');
        });

        it('explains a missing bytes option instead of failing generically', async () => {
            const upload = new ReactNativeFileUploadRequest({ uri: 'file:///a.jpg' });
            await assert.rejects(upload.bytes(), /has no `bytes` option/);
        });
    });

    it('makes HTTP requests via the configured client', async () => {
        const pets = [{ id: '1', name: 'Rex', tag: 'dog' }];

        const server = createServer((req: IncomingMessage, res: ServerResponse) => {
            if (req.url === '/pets' && req.method === 'GET') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(pets));
                return;
            }
            res.writeHead(404);
            res.end();
        });

        await new Promise<void>(resolve => server.listen(0, resolve));
        const { port } = server.address() as { port: number };

        try {
            const { client } = await import('./generated/client.gen.js');
            client.setConfig({ baseUrl: `http://localhost:${port}` });

            const result = await client.get({ url: '/pets' });
            assert.deepEqual(result.data, pets);
        } finally {
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    });
});
