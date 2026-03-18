import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { describe, it, before } from 'node:test';

import { configureOpenApiClient, type OpenApiClient } from '../../src/client/client.js';
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
            onError: () => null
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
