import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { describe, it, before } from 'node:test';

import { configureOpenApiClient, type OpenApiClient } from '../../src/client/client.js';
import { patchRequestOptionsForFileUpload } from '../../src/client/uploads.js';
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
