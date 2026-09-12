import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, link, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Wallet, encryptKeystoreJson } from 'quais';
import { isCyprus1Address } from '@daoships/sdk';
import { Context } from '../dist/context.js';
import { keystoreKey, decryptWallet, encryptWallet, generateWallet, validateKeystore } from '../dist/keystore.js';
import { readPassword, readSecretFile } from '../dist/secrets.js';
import { COMMANDS, execute, findCommand } from '../dist/commands.js';
import { context, directory, A, B } from './helpers.mjs';

const PASSWORD = 'public test password only', NEW_PASSWORD = 'a different public test password';
let wallet;
for (let i = 1; !wallet; i++) { const candidate = new Wallet('0x' + i.toString(16).padStart(64, '0')); if (isCyprus1Address(candidate.address)) wallet = candidate; }
let encrypted;
const fixture = async () => encrypted ??= await encryptWallet(wallet, PASSWORD, new AbortController().signal);
const run = (ctx, path, input) => execute(ctx, findCommand(path), input);
async function secretFile(t, value, name = 'password') { const path = join(await directory(t), name); await writeFile(path, value, { mode: 0o600 }); return path; }

test('strong V3 keystores round trip, randomize encryption and reject wrong passwords or tampering', async () => {
  const key = await fixture(), signal = new AbortController().signal;
  assert.equal((await decryptWallet(key.json, PASSWORD, signal)).address, wallet.address);
  assert.equal(JSON.parse(key.json).Crypto.kdfparams.n, 131072);
  await assert.rejects(decryptWallet(key.json, 'wrong', signal), { code: 'UNLOCK_FAILED' });
  const corrupt = JSON.parse(key.json); corrupt.address = B.slice(2);
  await assert.rejects(decryptWallet(JSON.stringify(corrupt), PASSWORD, signal), { code: 'UNLOCK_FAILED' });
  const fresh = await encryptWallet(wallet, PASSWORD, signal);
  assert.notEqual(fresh.json, key.json); assert.equal(fresh.address, key.address);
  assert.ok(!key.json.includes(wallet.privateKey)); assert.ok(!key.json.includes(PASSWORD));
});

test('hostile KDFs and ambiguous fields fail before derivation; weak imports require explicit consent', async () => {
  const base = JSON.parse((await fixture()).json);
  for (const patch of [{ n: 2 ** 31 }, { n: 3 }, { r: 1024 }, { p: 64 }, { n: 262144, r: 16 }, { dklen: 64 }, { salt: '00' }, { n: '131072' }]) {
    const bad = structuredClone(base); Object.assign(bad.Crypto.kdfparams, patch);
    assert.throws(() => validateKeystore(JSON.stringify(bad)));
  }
  const weak = structuredClone(base); weak.Crypto.kdfparams.n = 4096;
  assert.throws(() => validateKeystore(JSON.stringify(weak)), { code: 'WEAK_KEYSTORE' });
  assert.doesNotThrow(() => validateKeystore(JSON.stringify(weak), true));
  const ambiguous = structuredClone(base); ambiguous.crypto = structuredClone(base.Crypto);
  assert.throws(() => validateKeystore(JSON.stringify(ambiguous)), { code: 'KEYSTORE' });
  const upper = structuredClone(base); upper.Crypto.kdfparams.N = upper.Crypto.kdfparams.n;
  assert.throws(() => validateKeystore(JSON.stringify(upper)), { code: 'KEYSTORE' });
  const pbkdf = structuredClone(base); pbkdf.Crypto.kdf = 'pbkdf2'; pbkdf.Crypto.kdfparams = { c: 2000001, dklen: 32, prf: 'hmac-sha256', salt: 'ab'.repeat(32) };
  assert.throws(() => validateKeystore(JSON.stringify(pbkdf)), { code: 'KEYSTORE' });
});

test('secret files preserve password spaces and reject permissions, links, directories and excess data', async t => {
  const path = await secretFile(t, '  a real password  \r\n');
  assert.equal(await readPassword(path, new AbortController().signal, true), '  a real password  ');
  const sym = path + '.sym', hard = path + '.hard'; await symlink(path, sym);
  await assert.rejects(readSecretFile(sym));
  await link(path, hard); await assert.rejects(readSecretFile(path), { code: 'SECRET_FILE' });
  const other = await secretFile(t, 'pass'); await chmod(other, 0o644);
  await assert.rejects(readSecretFile(other), { code: 'SECRET_FILE' });
  await assert.rejects(readSecretFile(await directory(t)), { code: 'SECRET_FILE' });
  await assert.rejects(readSecretFile(await secretFile(t, 'x'.repeat(4097))), { code: 'SECRET_FILE' });
  await assert.rejects(readPassword(await secretFile(t, 'short'), new AbortController().signal, true), { code: 'PASSWORD' });
});

test('wallet lifecycle stores only ciphertext and supports fresh-password backups, restore and deletion', async t => {
  const ctx = await context(t, { from: undefined, passwordFile: await secretFile(t, PASSWORD), newPasswordFile: await secretFile(t, NEW_PASSWORD), keyFile: await secretFile(t, wallet.privateKey) });
  const imported = await run(ctx, 'wallet import', { name: 'primary' });
  assert.equal(imported.address, wallet.address); assert.equal(imported.kind, 'keystore');
  assert.equal((await ctx.signer()).address, wallet.address);
  const visible = JSON.stringify(await run(ctx, 'config show', {}));
  assert.ok(!visible.includes(PASSWORD)); assert.ok(!visible.includes(wallet.privateKey)); assert.ok(!visible.includes('ciphertext'));
  await assert.rejects(run(ctx, 'wallet import', { name: 'primary' }), { code: 'WALLET_EXISTS' });
  const backup = join(await directory(t), 'backup.json');
  assert.equal((await run(ctx, 'wallet export', { name: 'primary', file: backup })).encrypted, true);
  await assert.rejects(run(ctx, 'wallet export', { name: 'primary', file: backup }), { code: 'EEXIST' });
  await run(ctx, 'wallet import-keystore', { name: 'restored', file: backup });
  ctx.flags.passwordFile = ctx.flags.newPasswordFile;
  assert.equal((await run(ctx, 'wallet verify', { name: 'restored' })).verified, true);
  assert.equal((await ctx.signer()).address, wallet.address);
  ctx.flags.from = A;
  await assert.rejects(ctx.signer(), { code: 'SIGNER_MISMATCH' }); delete ctx.flags.from;
  ctx.flags.passwordFile = await secretFile(t, PASSWORD);
  await run(ctx, 'wallet change-password', { name: 'primary' });
  await assert.rejects(run(ctx, 'wallet verify', { name: 'primary' }), { code: 'UNLOCK_FAILED' });
  ctx.flags.passwordFile = ctx.flags.newPasswordFile;
  assert.equal((await run(ctx, 'wallet verify', { name: 'primary' })).verified, true);
  await assert.rejects(run(ctx, 'wallet remove', { name: 'restored' }), { code: 'CONSENT_REQUIRED' });
  ctx.flags.yes = true; await run(ctx, 'wallet remove', { name: 'restored' });
  assert.equal(ctx.store.get(keystoreKey('restored')), null);
  assert.equal(JSON.parse(await readFile(backup, 'utf8')).version, 3);
  const bytes = await readFile(join(ctx.store.directory, 'state.sqlite'));
  assert.ok(!bytes.includes(wallet.privateKey)); assert.ok(!bytes.includes(PASSWORD)); assert.ok(!bytes.includes(NEW_PASSWORD));
});

test('legacy wallets require explicit migration and verify source identity without modifying plaintext', async t => {
  const env = await secretFile(t, `TEST_MIGRATION_KEY=${wallet.privateKey}\n`);
  const ctx = await context(t, { from: undefined, keyEnvFile: env, passwordFile: await secretFile(t, PASSWORD) });
  ctx.config.wallets.legacy = { address: wallet.address, env: 'TEST_MIGRATION_KEY' }; ctx.config.wallet = 'legacy'; ctx.save();
  await assert.rejects(ctx.signer(), { code: 'MIGRATION_REQUIRED' });
  await run(ctx, 'wallet migrate', { name: 'legacy' });
  assert.deepEqual(ctx.config.wallets.legacy, { kind: 'keystore', address: wallet.address });
  assert.equal((await ctx.signer()).address, wallet.address);
  assert.ok((await readFile(env, 'utf8')).includes(wallet.privateKey));
});

test('weak imported encryption is replaced and never remains weak in storage', async t => {
  const weak = await encryptKeystoreJson({ address: wallet.address, privateKey: wallet.privateKey }, PASSWORD, { scrypt: { N: 4096, r: 8, p: 1 } });
  const file = await secretFile(t, weak), ctx = await context(t, { passwordFile: await secretFile(t, PASSWORD), newPasswordFile: await secretFile(t, NEW_PASSWORD) });
  await assert.rejects(run(ctx, 'wallet import-keystore', { name: 'weak', file }), { code: 'WEAK_KEYSTORE' });
  ctx.flags.allowWeakKeystore = true;
  await run(ctx, 'wallet import-keystore', { name: 'upgraded', file });
  assert.doesNotThrow(() => validateKeystore(ctx.store.get(keystoreKey('upgraded')).json));
});

test('public configuration CAS detects other processes and atomically rolls back key/profile writes', async t => {
  const ctx = await context(t), other = await Context.open({ configDir: ctx.store.directory }); t.after(() => other.close());
  other.config.address = B; other.save();
  ctx.config.wallets.conflict = { kind: 'keystore', address: wallet.address };
  assert.throws(() => ctx.save([{ key: keystoreKey('conflict'), previous: null, next: { ciphertext: 'public-test-placeholder' } }]), { code: 'CONFIG_CHANGED' });
  assert.equal(ctx.store.get(keystoreKey('conflict')), null); assert.equal(ctx.config.address, B); assert.equal(ctx.config.wallets.conflict, undefined);
  ctx.config.aliases.friend = A; ctx.save();
  assert.equal(ctx.store.get('config').address, B);
});

test('generation returns a Cyprus-1 account and cancellation prevents encryption or persistence', async t => {
  const signal = new AbortController();
  assert.ok(isCyprus1Address((await generateWallet(signal.signal)).address));
  signal.abort(); await assert.rejects(generateWallet(signal.signal)); await assert.rejects(encryptWallet(wallet, PASSWORD, signal.signal));
  const ctx = await context(t); ctx.abort.abort();
  await assert.rejects(run(ctx, 'wallet create', { name: 'cancelled' })); assert.equal(ctx.store.get(keystoreKey('cancelled')), null);
});

test('wallet operations requiring secrets are isolated by the shared TUI command registry', () => {
  for (const name of ['create', 'import', 'import-keystore', 'migrate', 'verify', 'change-password', 'remove']) assert.equal(findCommand('wallet ' + name).secret, true);
  assert.equal(COMMANDS.some(c => c.fields.some(f => /password|private.?key/i.test(f.name))), false);
});

test('agent key-file import has clean JSON output and structured missing-password failures', async t => {
  const dir = await directory(t), key = await secretFile(t, wallet.privateKey), pass = await secretFile(t, PASSWORD);
  const invoke = args => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [new URL('../dist/bin.js', import.meta.url).pathname, '--config-dir', dir, '--json', ...args], { env: { ...process.env, DAOSHIPS_KEYSTORE_PASSWORD_FILE: '', DAOSHIPS_NEW_PASSWORD_FILE: '' } });
    let out = '', err = ''; child.stdout.on('data', c => { out += c; }); child.stderr.on('data', c => { err += c; }); child.on('error', reject);
    child.on('close', code => { try { resolve({ code, result: JSON.parse(out), combined: out + err }); } catch (error) { reject(error); } });
  });
  const missing = await invoke(['--key-file', key, 'wallet', 'import', 'agent']);
  assert.equal(missing.code, 3); assert.equal(missing.result.error.code, 'SECRET_REQUIRED');
  const ok = await invoke(['--key-file', key, '--password-file', pass, 'wallet', 'import', 'agent']);
  assert.equal(ok.code, 0); assert.equal(ok.result.data.address, wallet.address); assert.ok(!ok.combined.includes(wallet.privateKey)); assert.ok(!ok.combined.includes(PASSWORD));
});
