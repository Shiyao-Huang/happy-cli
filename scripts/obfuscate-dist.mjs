#!/usr/bin/env node

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JavaScriptObfuscator from 'javascript-obfuscator';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const distDir = path.join(repoRoot, 'dist');

async function collectJsFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectJsFiles(fullPath));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!(fullPath.endsWith('.mjs') || fullPath.endsWith('.cjs'))) continue;
    files.push(fullPath);
  }

  return files;
}

const jsFiles = await collectJsFiles(distDir);

for (const filePath of jsFiles) {
  const code = await readFile(filePath, 'utf8');
  const result = JavaScriptObfuscator.obfuscate(code, {
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
  });
  await writeFile(filePath, result.getObfuscatedCode(), 'utf8');
}

console.log(`Obfuscated ${jsFiles.length} files under dist/`);
