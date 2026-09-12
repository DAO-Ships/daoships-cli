import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Interface } from 'quais';
import { DaoShipsError } from '@daoships/sdk';
import { errorInfo } from '../dist/values.js';
import { Harness, childEnvironment, fingerprint, limits, reserve, canRetryRead } from '../scripts/orchard/harness.mjs';
import { directory } from './helpers.mjs';

test('Orchard plan is offline and conflicting execution modes cannot import keys', async t => {
  const path = join(await directory(t), 'unused');
  const args = ['scripts/orchard-acceptance.mjs', '--plan', '--key-env-file', join(path, 'missing.env'), '--fixtures', join(path, 'missing.json'), '--directory', path];
  const exec = promisify(execFile);
  const { stdout } = await exec(process.execPath, args, { env: childEnvironment() });
  assert.equal(JSON.parse(stdout).sends, false);
  await assert.rejects(exec(process.execPath, [...args, '--execute'], { env: childEnvironment() }), /Choose exactly one mode/);
  await assert.rejects(access(path), { code: 'ENOENT' });
});

test('key dotenv option cannot cause Node to preload environment settings', async t => {
  const path = await directory(t), file = join(path, 'keys.env');
  await writeFile(file, `NODE_OPTIONS="--require ${join(path, 'must-not-load.cjs')}"\n`, { mode: 0o600 });
  const { stdout } = await promisify(execFile)(process.execPath, ['dist/bin.js', '--config-dir', join(path, 'state'), '--json',
    '--key-env-file', file, 'wallet', 'list'], { env: childEnvironment() });
  assert.equal(JSON.parse(stdout).ok, true);
});

test('CLI decodes a nested contract rejection without exposing the RPC request', () => {
  const iface = new Interface(['error NotAuthorized()']);
  const cause = Object.assign(new Error('sensitive RPC URL'), { data: iface.encodeErrorResult('NotAuthorized'), transaction: { privateKey: 'secret' } });
  const result = errorInfo(new DaoShipsError('CHAIN_ERROR', 'Contract provider call failed.', {}, { cause }));
  assert.equal(result.code, 'CHAIN_ERROR'); assert.equal(result.exitCode, 3);
  assert.equal(result.details.revert.name, 'NotAuthorized');
  assert(!JSON.stringify(result).includes('secret')); assert(!JSON.stringify(result).includes('sensitive'));
  const network = errorInfo(new DaoShipsError('CHAIN_ERROR', 'Contract provider call failed.', {}, { cause: new Error('offline') }));
  assert.equal(network.exitCode, 1); assert.equal(network.details.revert, undefined);
});

test('Orchard child processes receive no test keys, npm tokens, or injected Node options', () => {
  assert.deepEqual(childEnvironment({ PATH: '/bin', HOME: '/tmp/example', ORCHARD_PRIVATE_KEY: 'secret',
    ORCHARD_MEMBER_PRIVATE_KEY: 'secret2', NPM_TOKEN: 'token', NODE_OPTIONS: '--import=unsafe' }), { PATH: '/bin', HOME: '/tmp/example' });
});

test('Orchard reservations count attempts, enforce budgets and reject changed intents', () => {
  const state = { operations: {} }, intent = { command: 'transfer', input: { amount: '1000' }, wallet: 'owner' };
  reserve(state, 'one', intent, '1000'); reserve(state, 'one', intent, '1000');
  assert.equal(Object.keys(state.operations).length, 1);
  assert.throws(() => reserve(state, 'one', { ...intent, wallet: 'member' }, '1000'), /intent changed/);
  assert.throws(() => reserve(state, 'two', intent, '1001'), /value exceeds/);
  for (let i = 2; i <= 10; i++) reserve(state, String(i), intent, '1000');
  assert.throws(() => reserve(state, 'eleven', intent, '1'), /Total test value/);
  const attempts = { operations: {} };
  for (let i = 0; i < limits.transactions; i++) reserve(attempts, String(i), intent, '0');
  assert.throws(() => reserve(attempts, 'overflow', intent, '0'), /Transaction budget/);
});

test('Orchard resumes through recovery before simulating an already applied action', async () => {
  const h = new Harness('/tmp/unused-orchard-test', {}), input = { proposal: '2' }, wallet = 'owner', command = 'proposal cancel';
  const id = 'orchard-cli:unit:cancel', operation = { digest: fingerprint({ command, input, wallet }), attempted: true };
  h.state = { run: 'unit', operations: { [id]: operation } }; h.save = async () => {};
  const calls = []; h.cli = async path => { calls.push(path); return path === 'tx show' ? { hash: 'known' } : { outcome: 'mined', record: { hash: 'known' } }; };
  assert.deepEqual(await h.send('cancel', command, input, wallet), { hash: 'known' });
  assert.deepEqual(calls, ['tx show', 'tx recover']);
  h.cli = async path => path === 'tx show' ? { status: 'broadcast_unknown' } : { outcome: 'not_sent', record: {} };
  await assert.rejects(h.send('cancel', command, input, wallet), /manual reconciliation/);
  h.cli = async () => null;
  await assert.rejects(h.send('cancel', command, input, wallet), /previous send attempt/);
});

test('Orchard negative cases require the intended contract error', async () => {
  const h = new Harness('/tmp/unused-orchard-test', {}); h.state = { facts: {} };
  h.progress = () => {}; h.memo = async (_key, fn) => fn();
  const fail = name => async () => { throw Object.assign(new Error('Contract failed'), { code: 'CHAIN_ERROR', details: { revert: { selector: '0x12345678', name } } }); };
  h.cli = fail('AlreadyVoted');
  await assert.rejects(h.rejected('unauthorized-timelock-queue', 'TimelockNavigator', 'unused', 'queueChange', []), /Expected NotAuthorized/);
  h.cli = fail('NotAuthorized');
  await h.rejected('unauthorized-timelock-queue', 'TimelockNavigator', 'unused', 'queueChange', []);
});

test('transient read retries cannot retry sends, wallet changes, pending outcomes or contract reverts', () => {
  const offline = { code: 'CHAIN_ERROR', details: {} };
  assert(canRetryRead('proposal show', [], offline));
  assert(canRetryRead('proposal submit', [], offline)); // simulation only
  assert(canRetryRead('tx recover', [], offline)); // never broadcasts
  assert(!canRetryRead('proposal submit', ['--send', '--yes'], offline));
  assert(!canRetryRead('wallet import', [], offline));
  assert(!canRetryRead('tx recover', [], { code: 'TX_PENDING', details: {} }));
  assert(!canRetryRead('contract write', [], { ...offline, details: { revert: { name: 'NotAuthorized' } } }));
});
