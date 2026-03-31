#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JavaScriptObfuscator from 'javascript-obfuscator';
import { protectPublishArtifacts } from './lib/npmPublishProtection.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const distDir = path.join(repoRoot, 'dist');

const files = await protectPublishArtifacts({
  rootDir: distDir,
  transform: (code) => JavaScriptObfuscator.obfuscate(code, {
    compact: true,
    controlFlowFlattening: false,
    deadCodeInjection: false,
    debugProtection: false,
    disableConsoleOutput: false,
    identifierNamesGenerator: 'hexadecimal',
    ignoreImports: true,
    renameGlobals: false,
    renameProperties: false,
    selfDefending: false,
    simplify: true,
    splitStrings: true,
    splitStringsChunkLength: 8,
    stringArray: true,
    stringArrayEncoding: ['base64'],
    stringArrayThreshold: 0.75,
    target: 'node',
    transformObjectKeys: false,
    unicodeEscapeSequence: false,
    sourceMap: false,
  }).getObfuscatedCode(),
});

console.log(`Obfuscated ${files.length} files under dist/`);
