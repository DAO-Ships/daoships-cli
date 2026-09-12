import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Wallet } from 'quais';
import { isCyprus1Address } from '@daoships/sdk';
import { directory } from './helpers.mjs';

test('real terminal masks secret entry and restores TUI after success, wrong password, cancellation and resize', { timeout: 90000, skip: process.platform === 'win32' }, async t => {
  let wallet;
  for (let i = 1; !wallet; i++) { const candidate = new Wallet('0x' + i.toString(16).padStart(64, '0')); if (isCyprus1Address(candidate.address)) wallet = candidate; }
  const { stdout } = await promisify(execFile)('python3', [
    new URL('./fixtures/terminal-wallet.py', import.meta.url).pathname,
    process.execPath, new URL('./fixtures/tui-wallet.mjs', import.meta.url).pathname,
    await directory(t), wallet.privateKey,
  ], { timeout: 80000, maxBuffer: 1024 * 1024 });
  assert.equal(JSON.parse(stdout).secretsHidden, true);
});
