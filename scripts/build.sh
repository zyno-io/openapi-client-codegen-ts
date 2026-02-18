#!/usr/bin/env bash
set -euo pipefail

# Compile ESM and CJS for both client and generator
tsc -p tsconfig.client.json
tsc -p tsconfig.generator.json
tsc -p tsconfig.client.cjs.json
tsc -p tsconfig.generator.cjs.json

# Rename CJS .js files to .cjs
find dist/cjs -name '*.js' -exec sh -c 'mv "$1" "${1%.js}.cjs"' _ {} \;

# Update require() paths to reference .cjs extensions
find dist/cjs -name '*.cjs' -exec perl -i -pe 's/\.js"\)/\.cjs"\)/g' {} \;

# Make the CLI executable
chmod +x ./dist/esm/src/generator/cli.js
