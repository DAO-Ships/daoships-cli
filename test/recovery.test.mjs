import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { assertRecoveryStoreConformance, recoveryAccountKey, recoveryTransactionKey } from '@daoships/sdk';
import { Store } from '../dist/store.js';
import { transact, reviewHash } from '../dist/actions.js';
import { CliError } from '../dist/values.js';
import { directory, context, prepared, transport, A } from './helpers.mjs';

test('SQLite passes published SDK adapter conformance across independent connections', async t => {
  const dir = await directory(t), stores = [];
  t.after(() => stores.forEach(s => s.close()));
  const report = await assertRecoveryStoreConformance(async () => { const store = await Store.open(dir); stores.push(store); return store; }, { namespace: 'cli-store', contenders: 8 });
  assert.ok(report.checks.length >= 8);
});
test('cross-process CAS permits exactly one account reservation', async t => {
  const dir = await directory(t); const store = await Store.open(dir); t.after(() => store.close());
  const record = { version: 1, kind: 'nonce', id: recoveryAccountKey(15000, A), revision: 0, chainId: 15000, from: A, nextNonce: 1, blockedBy: 'one' };
  const source = `import {Store} from ${JSON.stringify(new URL('../dist/store.js', import.meta.url).href)}; const s=await Store.open(process.argv[1]); const r=JSON.parse(process.argv[2]); console.log(await s.compareAndSwap(r.id,null,r)); s.close();`;
  const results = await Promise.all(Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, dir, JSON.stringify(record)]); let out = '', err = '';
    child.stdout.on('data', c => { out += c; }); child.stderr.on('data', c => { err += c; }); child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(out.trim()) : reject(Error(err)));
  })));
  assert.equal(results.filter(r => r === 'true').length, 1); assert.equal(results.filter(r => r === 'false').length, 5);
});
test('process death rolls back an incomplete SQLite write and releases its lock', { timeout: 10000 }, async t => {
  const dir = await directory(t), store = await Store.open(dir); t.after(() => store.close());
  store.put('crash', { value: 'before' });
  const source = `import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.argv[1]+'/state.sqlite'); db.exec('BEGIN IMMEDIATE'); db.prepare('UPDATE documents SET data=? WHERE key=?').run('{"value":"after"}','crash'); process.stdout.write('locked'); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(([code]) => { throw Error('Crash fixture exited early: ' + code); })]);
  const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended;
  assert.deepEqual(store.get('crash'), { value: 'before' }); store.put('after-crash', { okay: true });
  assert.deepEqual(store.get('after-crash'), { okay: true });
});
test('previews never access a wallet or modify the journal', async t => {
  const ctx = await context(t); let keys = 0; ctx.signer = async () => { keys++; throw Error('key accessed'); };
  const result = await transact(ctx, { prepare: async () => prepared({ value: 3n }) });
  assert.equal(result.mode, 'preview'); assert.equal(result.transaction.value, 3n); assert.equal(keys, 0); assert.equal(ctx.store.records().length, 0);
});
test('review hash binds exact intent and value caps fail before signing', async t => {
  const tx = prepared({ value: 1n }), ctx = await context(t, { send: true, yes: true, id: 'reviewed', expectHash: reviewHash(tx) });
  const f = transport(ctx, tx);
  await assert.rejects(transact(ctx, { prepare: async () => ({ ...tx, value: 2n }) }), { code: 'PLAN_CHANGED' });
  ctx.flags.expectHash = undefined; ctx.flags.maxValue = '0'; await assert.rejects(transact(ctx, f.action), { code: 'LIMIT' });
  assert.equal(f.calls.length, 0);
});
test('noninteractive sends require consent and a stable operation ID', async t => {
  const ctx = await context(t, { send: true }); const f = transport(ctx, prepared());
  await assert.rejects(transact(ctx, f.action), { code: 'USAGE' });
  ctx.flags.id = 'consent'; await assert.rejects(transact(ctx, f.action), { code: 'CONSENT_REQUIRED' }); assert.equal(f.calls.length, 0);
});
test('confirmed one-shot sends persist hashes and repeated IDs never broadcast again', async t => {
  const ctx = await context(t, { send: true, yes: true, id: 'confirmed' }); const f = transport(ctx, prepared());
  const first = await transact(ctx, f.action), second = await transact(ctx, f.action);
  assert.equal(first.mode, 'mined'); assert.equal(first.changed, true); assert.equal(second.changed, false); assert.equal(f.calls.length, 1);
  assert.equal((await ctx.store.read(recoveryTransactionKey('confirmed'))).status, 'mined');
});
test('business outcome failures retain transaction hash and return nonzero failure', async t => {
  const ctx = await context(t, { send: true, yes: true, id: 'business-failure' }); const f = transport(ctx, prepared());
  await assert.rejects(transact(ctx, { ...f.action, finish: () => { throw new CliError('ACTION_FAILED', 'Proposal actions failed.', {}, 3); } }), error => error.code === 'ACTION_FAILED' && error.details.hash && error.exitCode === 3);
  assert.equal(f.calls.length, 1);
});
test('gas cap rejection stays provably unsent and releases its reserved nonce', async t => {
  const ctx = await context(t, { send: true, yes: true, id: 'gas-limit', maxGas: '100' }); const f = transport(ctx, prepared());
  await assert.rejects(transact(ctx, f.action), error => error.code === 'LIMIT' && error.exitCode === 3 && error.details.gasLimit === 120n && error.details.maximumGas === 100n);
  assert.equal(f.calls.length, 0); assert.equal((await ctx.store.read(recoveryTransactionKey('gas-limit'))).status, 'not_sent');
  assert.equal((await ctx.store.read(recoveryAccountKey(15000, A))).blockedBy, null);
});
test('ambiguous broadcasts quarantine the account across reopened processes', async t => {
  const ctx = await context(t, { send: true, yes: true, id: 'uncertain' }); const f = transport(ctx, prepared());
  f.wallet.sendTransaction = async () => { throw Error('transport lost after submission'); };
  await assert.rejects(transact(ctx, f.action), { code: 'BROADCAST_ERROR' });
  const reopened = await Store.open(ctx.store.directory); t.after(() => reopened.close());
  assert.equal((await reopened.read(recoveryAccountKey(15000, A))).blockedBy, 'uncertain');
  ctx.flags.id = 'another'; await assert.rejects(transact(ctx, f.action), { code: 'RECOVERY_BLOCKED' });
});
