import { readdir } from 'node:fs/promises';
const files = (await readdir(new URL('../test/', import.meta.url))).filter(f => f.endsWith('.test.mjs')).sort();
for (const file of files) await import(new URL('../test/' + file, import.meta.url));
