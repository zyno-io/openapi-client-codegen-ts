import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, before } from 'node:test';

import { generateConfiguredOpenapiClients, generateOpenapiClient } from '../../src/generator/generator.js';

const SPEC_PATH = path.join(import.meta.dirname, 'petstore.yaml');
const OUT_PATH = path.join(import.meta.dirname, 'generated-filtered');

rmSync(OUT_PATH, { recursive: true, force: true });

describe('Spec Filtering: operations subset', () => {
    before(async () => {
        await generateOpenapiClient(SPEC_PATH, OUT_PATH, ['listPets']);
    });

    it('generates expected SDK files', () => {
        assert.ok(existsSync(path.join(OUT_PATH, 'sdk.gen.ts')));
        assert.ok(existsSync(path.join(OUT_PATH, 'types.gen.ts')));
    });

    it('only includes the specified operation in the SDK', () => {
        const sdk = readFileSync(path.join(OUT_PATH, 'sdk.gen.ts'), 'utf8');
        assert.ok(sdk.includes('listPets'), 'should include listPets');
        assert.ok(!sdk.includes('createPet'), 'should not include createPet');
        assert.ok(!sdk.includes('getPet'), 'should not include getPet');
    });

    it('includes directly referenced schemas', () => {
        const types = readFileSync(path.join(OUT_PATH, 'types.gen.ts'), 'utf8');
        assert.ok(types.includes('Pet'), 'should include Pet (referenced by listPets response)');
    });

    it('includes transitively referenced schemas', () => {
        const types = readFileSync(path.join(OUT_PATH, 'types.gen.ts'), 'utf8');
        assert.ok(types.includes('Owner'), 'should include Owner (referenced by Pet)');
    });

    it('excludes schemas only used by filtered-out operations', () => {
        const types = readFileSync(path.join(OUT_PATH, 'types.gen.ts'), 'utf8');
        assert.ok(!types.includes('CreatePetRequest'), 'should not include CreatePetRequest');
    });
});

describe('Spec Filtering: multiple operations', () => {
    const outPath = path.join(import.meta.dirname, 'generated-filtered-multi');

    before(async () => {
        rmSync(outPath, { recursive: true, force: true });
        await generateOpenapiClient(SPEC_PATH, outPath, ['listPets', 'createPet']);
    });

    it('includes both specified operations', () => {
        const sdk = readFileSync(path.join(outPath, 'sdk.gen.ts'), 'utf8');
        assert.ok(sdk.includes('listPets'), 'should include listPets');
        assert.ok(sdk.includes('createPet'), 'should include createPet');
        assert.ok(!sdk.includes('getPet'), 'should not include getPet');
    });

    it('includes schemas from both operations', () => {
        const types = readFileSync(path.join(outPath, 'types.gen.ts'), 'utf8');
        assert.ok(types.includes('Pet'), 'should include Pet');
        assert.ok(types.includes('CreatePetRequest'), 'should include CreatePetRequest');
        assert.ok(types.includes('Owner'), 'should include Owner (transitive via Pet)');
    });
});

describe('Spec Filtering: no filter generates everything', () => {
    const outPath = path.join(import.meta.dirname, 'generated-filtered-all');

    before(async () => {
        rmSync(outPath, { recursive: true, force: true });
        await generateOpenapiClient(SPEC_PATH, outPath);
    });

    it('includes all operations', () => {
        const sdk = readFileSync(path.join(outPath, 'sdk.gen.ts'), 'utf8');
        assert.ok(sdk.includes('listPets'));
        assert.ok(sdk.includes('createPet'));
        assert.ok(sdk.includes('getPet'));
    });

    it('includes all schemas', () => {
        const types = readFileSync(path.join(outPath, 'types.gen.ts'), 'utf8');
        assert.ok(types.includes('Pet'));
        assert.ok(types.includes('CreatePetRequest'));
        assert.ok(types.includes('Owner'));
    });
});

describe('Spec Filtering: operations via IGeneratorConfig', () => {
    const outPath = path.join(import.meta.dirname, 'generated-filtered-config');

    before(async () => {
        rmSync(outPath, { recursive: true, force: true });
        await generateOpenapiClient(SPEC_PATH, { path: outPath, operations: ['listPets'] });
    });

    it('only includes the specified operation in the SDK', () => {
        const sdk = readFileSync(path.join(outPath, 'sdk.gen.ts'), 'utf8');
        assert.ok(sdk.includes('listPets'), 'should include listPets');
        assert.ok(!sdk.includes('createPet'), 'should not include createPet');
        assert.ok(!sdk.includes('getPet'), 'should not include getPet');
    });

    it('excludes schemas only used by filtered-out operations', () => {
        const types = readFileSync(path.join(outPath, 'types.gen.ts'), 'utf8');
        assert.ok(types.includes('Pet'), 'should include Pet');
        assert.ok(types.includes('Owner'), 'should include Owner (transitive)');
        assert.ok(!types.includes('CreatePetRequest'), 'should not include CreatePetRequest');
    });
});

describe('Spec Filtering: preserves spec structure', () => {
    it('filtered YAML is valid and has correct structure', async () => {
        // Manually import and test the filtering by generating with a single op
        const outPath = path.join(import.meta.dirname, 'generated-filtered-structure');
        rmSync(outPath, { recursive: true, force: true });
        await generateOpenapiClient(SPEC_PATH, outPath, ['getPet']);

        const sdk = readFileSync(path.join(outPath, 'sdk.gen.ts'), 'utf8');
        assert.ok(sdk.includes('getPet'), 'should include getPet');
        assert.ok(!sdk.includes('listPets'), 'should not include listPets');
        assert.ok(!sdk.includes('createPet'), 'should not include createPet');

        const types = readFileSync(path.join(outPath, 'types.gen.ts'), 'utf8');
        assert.ok(types.includes('Pet'), 'should include Pet');
        assert.ok(types.includes('Owner'), 'should include Owner (transitive)');
        assert.ok(!types.includes('CreatePetRequest'), 'should not include CreatePetRequest');
    });
});

describe('Development spec syncing', () => {
    it('does not copy an identical development spec', async () => {
        const workDir = mkdtempSync(path.join(tmpdir(), 'openapi-dev-copy-'));
        const originalWorkingDirectory = process.cwd();
        const originalSpecPath = path.join(workDir, 'spec.yaml');
        const developmentSpecPath = path.join(workDir, 'spec.dev.yaml');
        const spec = readFileSync(SPEC_PATH, 'utf8');

        try {
            writeFileSync(originalSpecPath, spec);
            writeFileSync(developmentSpecPath, spec);
            writeFileSync(path.join(workDir, 'openapi-specs.json'), JSON.stringify({ './spec.yaml': './generated' }));
            writeFileSync(path.join(workDir, 'openapi-specs.dev.json'), JSON.stringify({ './spec.yaml': './spec.dev.yaml' }));

            const oldTimestamp = new Date('2000-01-01T00:00:00.000Z');
            utimesSync(originalSpecPath, oldTimestamp, oldTimestamp);

            process.chdir(workDir);
            await generateConfiguredOpenapiClients();

            assert.ok(statSync(originalSpecPath).mtimeMs < 1_000_000_000_000, 'identical spec should retain its timestamp');

            writeFileSync(developmentSpecPath, `${spec}\n# changed in development\n`);
            await generateConfiguredOpenapiClients();

            assert.equal(readFileSync(originalSpecPath, 'utf8'), readFileSync(developmentSpecPath, 'utf8'));
        } finally {
            process.chdir(originalWorkingDirectory);
            rmSync(workDir, { recursive: true, force: true });
        }
    });
});
