import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { directory, A, B } from './helpers.mjs';
const bin = new URL('../dist/bin.js', import.meta.url).pathname;
function cli(dir, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, '--config-dir', dir, ...args], { env: { ...process.env, ...env } }); let stdout = '', stderr = '';
    child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; }); child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}
test('CLI has clean JSON stdout, useful help and a complete agent schema', async t => {
  const dir = await directory(t);
  for (const args of [['--json', 'network', 'list'], ['network', 'list', '--json'], ['--json', 'run', 'network list', '{}']]) {
    const result = await cli(dir, args); assert.equal(result.code, 0, result.stdout + result.stderr);
    const out = JSON.parse(result.stdout); assert.equal(out.ok, true); assert.equal(out.data.active, 'orchard'); assert.equal(out.schemaVersion, 1);
  }
  const schema = await cli(dir, ['--schema']); assert.equal(schema.code, 0); assert.ok(JSON.parse(schema.stdout).commands.length > 60);
  const help = await cli(dir, ['proposal', 'vote', '--help']); assert.equal(help.code, 0); assert.match(help.stdout, /<proposal> <vote>/);
});
test('usage failures emit exactly one JSON envelope and a nonzero exit', async t => {
  const dir = await directory(t);
  for (const args of [['nonsense'], ['--network', 'fake', 'status'], ['proposal', 'vote'], ['run', 'status', '[]'], ['run', 'not-a-command', '{}'], ['tui']]) {
    const result = await cli(dir, ['--json', ...args]); assert.equal(result.code, 2, result.stdout + result.stderr); assert.equal(JSON.parse(result.stdout).ok, false);
  }
});
test('wallet watch, aliases and networks persist without a private key', async t => {
  const dir = await directory(t);
  for (const args of [['wallet', 'watch', A], ['alias', 'set', 'guild', B], ['dao', 'use', 'guild'], ['network', 'use', 'mainnet']]) assert.equal((await cli(dir, ['--json', ...args])).code, 0);
  const result = JSON.parse((await cli(dir, ['--json', 'config', 'show'])).stdout);
  assert.equal(result.data.daos.orchard, B); assert.equal(result.data.network, 'mainnet'); assert.equal(result.data.address, A); assert.deepEqual(result.data.wallets, {});
  assert.equal((await readdir(dir)).some(f => /key|keystore/i.test(f)), false);
});
test('file inputs work and output files never overwrite existing data', async t => {
  const dir = await directory(t), input = join(dir, 'actions.json'), output = join(dir, 'result.json');
  await writeFile(input, JSON.stringify([{ to: A, data: '0x', value: '9007199254740993' }]));
  const result = await cli(dir, ['--json', '--output', output, 'proposal', 'encode', '@' + input]); assert.equal(result.code, 0, result.stdout);
  const saved = await readFile(output, 'utf8'); assert.equal(JSON.parse(saved).data.actions[0].value, '9007199254740993');
  assert.notEqual((await cli(dir, ['--json', '--output', output, 'network', 'list'])).code, 0); assert.equal(await readFile(output, 'utf8'), saved);
  assert.notEqual((await cli(dir, ['--json', '--output', output, 'network', 'use', 'mainnet'])).code, 0);
  assert.equal(JSON.parse((await cli(dir, ['--json', 'network', 'list'])).stdout).data.active, 'orchard');
});
