import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, open, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv, promisify } from 'node:util';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
export const stringify = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? String(v) : v, 2);
export const fingerprint = value => createHash('sha256').update(stringify(value)).digest('hex');
export const limits = Object.freeze({ transactions: 80, gas: '12000000', valuePerTransaction: '1000', totalValue: '10000' });
export const expectedReverts = Object.freeze({
  'unauthorized-timelock-queue': 'NotAuthorized', 'premature-timelock': 'ChangeNotReady',
  'onboard-underpayment': 'InsufficientTribute', 'duplicate-signal-vote': 'AlreadyVoted',
  'missing-erc20-allowance': 'ERC20InsufficientAllowance', 'wrong-nft-owner': 'NotHolder',
  'duplicate-nft-onboarding': 'AlreadyClaimed', 'subscription-underpayment': 'IncorrectPayment',
  'premature-subscription-collection': 'NotDelinquent', 'unauthorized-vesting-claim': 'NotAuthorized',
  'duplicate-vesting-claim': 'NothingToClaim', 'unauthorized-budget-spend': 'NotAuthorized',
  'budget-period-ceiling': 'AllowanceExceeded', 'cancelled-budget-spend': 'BudgetCancelled_',
  'timelock-wrong-commitment': 'ConfigHashMismatch', 'duplicate-timelock-execution': 'ChangeAlreadyExecuted',
});
export function childEnvironment(env = process.env) {
  // A key used for import must never leak into unrelated CLI children.
  return Object.fromEntries(Object.entries(env).filter(([key]) => ['PATH', 'HOME', 'TMPDIR', 'LANG', 'TERM', 'SystemRoot'].includes(key)));
}
export function canRetryRead(command, flags, error) {
  const commands = ['doctor', 'status', 'dao show', 'proposal show', 'navigator list', 'indexer state', 'balance', 'token balance',
    'contract read', 'tx show', 'tx recover', 'tx events', 'contract write', 'proposal submit', 'proposal vote', 'proposal process',
    'proposal cancel', 'dao ragequit', 'transfer', 'token approve'];
  return !flags.includes('--send') && commands.includes(command) && !error.details?.revert
    && ['CHAIN_ERROR', 'TIMEOUT', 'ERROR'].includes(error.code);
}
export function reserve(state, id, intent, value) {
  const digest = fingerprint(intent), previous = state.operations[id];
  if (previous) { assert.equal(previous.digest, digest, 'Operation intent changed; retain the original journal.'); return previous; }
  assert(Object.keys(state.operations).length < limits.transactions, 'Transaction budget exhausted.');
  assert(BigInt(value) >= 0n && BigInt(value) <= BigInt(limits.valuePerTransaction), 'Transaction value exceeds the test budget.');
  const total = Object.values(state.operations).reduce((sum, op) => sum + BigInt(op.value), 0n) + BigInt(value);
  assert(total <= BigInt(limits.totalValue), 'Total test value budget exhausted.');
  return state.operations[id] = { digest, value: String(value), command: intent.command, wallet: intent.wallet };
}
export class Harness {
  constructor(directory, fixtures) { this.directory = resolve(directory); this.fixtures = fixtures; }
  async open() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.directory);
    assert(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0, 'Evidence directory must be private (0700), without symlinks.');
    this.lock = await open(join(this.directory, 'running.lock'), 'wx', 0o600);
    await this.lock.writeFile(stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    try { this.state = JSON.parse(await readFile(join(this.directory, 'state.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; this.state = { version: 1, chainId: 15000, run: randomUUID(), fixturesHash: fingerprint(this.fixtures), operations: {}, facts: {}, scenarios: {}, startedAt: new Date().toISOString() }; }
    assert.equal(this.state.chainId, 15000); assert.equal(this.state.fixturesHash, fingerprint(this.fixtures), 'Fixture identity changed.');
    for (const [key, fact] of Object.entries(this.state.facts)) if (key.startsWith('rejected:')) {
      assert.equal(fact.details?.revert?.name, expectedReverts[key.slice(9)], `Unexpected saved contract rejection: ${key}`);
    }
    await this.save();
    return this;
  }
  async close() { if (this.lock) { await this.lock.close(); await rm(join(this.directory, 'running.lock')); } }
  async save() {
    const path = join(this.directory, 'state.json'), temp = path + '.' + randomUUID() + '.tmp';
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(stringify(this.state) + '\n'); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, path);
    const dir = await open(this.directory, 'r'); try { await dir.sync(); } finally { await dir.close(); }
  }
  progress(stage, details = {}) { console.log(JSON.stringify({ stage, ...details })); }
  async cli(command, input = {}, wallet = 'owner', flags = [], attempt = 0) {
    const args = ['--', 'dist/bin.js', '--config-dir', join(this.directory, 'cli'), '--network', 'orchard', '--json', '--wallet', wallet,
      '--password-file', join(this.directory, 'password'), '--timeout', '120000', '--confirmations', '2', '--max-gas', limits.gas,
      '--max-value', limits.valuePerTransaction, ...flags, 'run', command, stringify(input)];
    let result;
    try { result = await exec(process.execPath, args, { cwd: root, env: childEnvironment(), timeout: 280000, maxBuffer: 4_194_304 }); }
    catch (error) { result = { stdout: error.stdout }; }
    let envelope;
    try { envelope = JSON.parse(result.stdout); } catch { throw Object.assign(new Error('CLI subprocess did not return a JSON envelope; inspect the durable transaction journal before resuming.'), { code: 'CLI_TRANSPORT' }); }
    if (!envelope.ok) {
      if (attempt < 2 && canRetryRead(command, flags, envelope.error)) {
        this.progress('read-retry', { command, attempt: attempt + 1 });
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        return this.cli(command, input, wallet, flags, attempt + 1);
      }
      throw Object.assign(new Error(envelope.error.message), { code: envelope.error.code, details: { command, wallet, ...envelope.error.details } });
    }
    assert.equal(envelope.chainId, 15000, 'Only Orchard is permitted.');
    return envelope.data;
  }
  async wallets(envFile) {
    const profiles = (await this.cli('wallet list')).wallets;
    const missing = ['owner', 'member'].filter(name => !profiles[name]);
    if (missing.length) {
      const values = parseEnv(await readFile(envFile, 'utf8'));
      const keys = { owner: values.ORCHARD_PRIVATE_KEY, member: values.ORCHARD_MEMBER_PRIVATE_KEY };
      for (const name of missing) assert(/^0x[\da-f]{64}$/i.test(keys[name] ?? ''), `Missing ${name} Orchard key in the SDK dotenv file.`);
      try { await writeFile(join(this.directory, 'password'), randomBytes(48).toString('base64'), { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      for (const name of missing) {
        const keyFile = join(this.directory, 'import-key');
        // Exclusive creation also detects an interrupted previous import.
        try {
          await writeFile(keyFile, keys[name], { flag: 'wx', mode: 0o600 });
          await this.cli('wallet import', { name }, name, ['--key-file', keyFile]);
        } finally { await rm(keyFile, { force: true }); }
      }
    }
    for (const name of ['owner', 'member']) {
      const result = await this.cli('wallet verify', { name }, name);
      assert.equal(result.address.toLowerCase(), this.fixtures.accounts[name].toLowerCase(), 'Wallet does not own the reviewed test fixture.');
      const balance = await this.cli('balance', {}, name);
      assert(BigInt(balance.wei) > 10n ** 17n, 'Test wallet needs at least 0.1 QUAI for fees.');
      this.progress('wallet-ready', { name, address: result.address, balanceWei: balance.wei });
    }
  }
  async memo(key, fn) {
    if (!Object.hasOwn(this.state.facts, key)) { this.state.facts[key] = await fn(); await this.save(); }
    return this.state.facts[key];
  }
  async scenario(name, fn, repeat = false) {
    if (this.state.scenarios[name] && !repeat) return;
    this.progress('scenario', { name });
    await fn(); this.state.scenarios[name] = { passedAt: new Date().toISOString() }; await this.save();
    this.progress('passed', { name });
  }
  async send(key, command, input, wallet = 'owner') {
    const id = `orchard-cli:${this.state.run}:${key}`;
    const intent = { command, input, wallet };
    const existing = this.state.operations[id];
    if (existing) assert.equal(existing.digest, fingerprint(intent), 'Operation intent changed.');
    // Recovery must precede a new simulation: the original call may now revert
    // precisely because its effects have already been applied.
    const record = await this.cli('tx show', { id }, wallet);
    if (record) {
      assert(existing, 'Untracked CLI operation; refusing to guess.');
      this.progress('recovering', { key, id });
      const result = await this.cli('tx recover', { id }, wallet);
      assert.equal(result.outcome, 'mined', 'Existing operation needs manual reconciliation; never automatically resubmit.');
      existing.hash = result.record.hash; existing.blockNumber ??= result.record.receipt?.blockNumber; await this.save();
      return { hash: result.record.hash };
    }
    assert(!existing?.attempted, 'A previous send attempt has no record; inspect before retrying.');
    const preview = await this.cli(command, input, wallet);
    assert.equal(preview.mode, 'preview'); assert.equal(preview.transaction.chainId, 15000);
    assert.equal(preview.transaction.from.toLowerCase(), this.fixtures.accounts[wallet].toLowerCase());
    const operation = reserve(this.state, id, intent, preview.transaction.value);
    operation.reviewHash = preview.reviewHash; operation.attempted = true; await this.save();
    this.progress('sending', { key, id, command, wallet });
    const sent = await this.cli(command, input, wallet, ['--send', '--yes', '--id', id, '--expect-hash', preview.reviewHash]);
    assert.equal(sent.mode, 'mined'); operation.hash = sent.hash; operation.blockNumber = sent.blockNumber; await this.save();
    this.progress('mined', { key, hash: sent.hash, blockNumber: sent.blockNumber });
    return sent;
  }
  read(kind, address, method, args = [], wallet = 'owner') { return this.cli('contract read', { kind, address, method, args }, wallet); }
  write(key, kind, address, method, args = [], wallet = 'owner', value = '0') { return this.send(key, 'contract write', { kind, address, method, args, value }, wallet); }
  async events(kind, address, hash, event) { return (await this.cli('tx events', { kind, address, hash, event })).events.map(e => e.args); }
  async rejected(key, kind, address, method, args, wallet = 'member', value = '0') {
    assert(expectedReverts[key], 'Register the exact expected contract error before testing rejection.');
    if (this.state.facts[`rejected:${key}`]) return;
    try { await this.cli('contract write', { kind, address, method, args, value }, wallet); }
    catch (error) {
      // A network failure is not proof that the contract rejected the call.
      assert.equal(error.code, 'CHAIN_ERROR'); assert(error.details?.revert?.selector, 'Expected a decoded contract revert, not an RPC outage.');
      assert.equal(error.details.revert.name, expectedReverts[key], `Expected ${expectedReverts[key]} for ${key}.`);
      await this.memo(`rejected:${key}`, async () => ({ code: error.code, details: error.details }));
      this.progress('rejected-as-expected', { key }); return;
    }
    assert.fail(`Expected ${key} to be rejected during simulation.`);
  }
  async until(name, predicate, timeoutMs = 900000) {
    const deadline = Date.now() + timeoutMs;
    while (!await predicate()) {
      assert(Date.now() < deadline, `${name} timed out; resume using the same evidence directory.`);
      this.progress('waiting', { name }); await new Promise(resolve => setTimeout(resolve, 15000));
    }
  }
}
