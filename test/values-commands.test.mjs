import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, ZeroAddress } from 'quais';
import * as sdk from '@daoships/sdk';
import { amount, parseJson, json, abiValue, safe, integer } from '../dist/values.js';
import { COMMANDS, contractMethods, execute, findCommand, methodFields, formArgs, receiptEvents } from '../dist/commands.js';
import { navigatorConfig, readPlan, grindCreation } from '../dist/deployments.js';
import { A, B, D, prepared, context, override } from './helpers.mjs';

test('amounts and JSON preserve uint256 precision and reject unsafe numeric input', () => {
  const large = (1n << 255n) + 1n;
  assert.equal(amount(large.toString()), large); assert.equal(json({ large }), `{"large":"${large}"}`);
  for (const value of [1.1, Number.MAX_SAFE_INTEGER + 1, '-1', '1e18', '01', (1n << 256n).toString(), '1'.repeat(10000)]) assert.throws(() => amount(value));
  for (const input of ['{"value":9007199254740993}', '{"__proto__":{}}', '{"x":1.2}', 'x'.repeat(2_097_153)]) assert.throws(() => parseJson(input));
  assert.throws(() => integer(-1, 'nonce')); assert.throws(() => integer('1.0', 'nonce'));
});
test('terminal text strips control sequences and bidi markers', () => {
  assert.equal(safe('DAO\x1b]52;c;key\x07\u202Ename\n'), 'DAO]52;c;keyname');
});
test('all published ABI functions are discoverable and have guided fields', () => {
  let count = 0;
  for (const [kind, abi] of Object.entries(sdk.CONTRACT_ABIS)) {
    const methods = contractMethods(kind), iface = new Interface(abi);
    assert.equal(methods.length, iface.fragments.filter(f => f.type === 'function').length);
    assert.equal(new Set(methods.map(m => m.signature)).size, methods.length);
    for (const method of methods) assert.equal(methodFields(kind, method.signature).length, method.inputs.length);
    count += methods.length;
  }
  assert.equal(Object.keys(sdk.CONTRACT_ABIS).length, 17); assert.equal(count, 353);
  assert.equal(new Set(COMMANDS.map(c => c.path)).size, COMMANDS.length);
  assert.equal(findCommand('navigator read').fields[0].choices.length, 8);
  assert.equal(findCommand('indexer get').fields[0].choices.length, Object.keys(sdk.indexerShapes).length);
});
test('tuple, array, boolean and signed integer forms preserve ABI types', () => {
  const iface = new Interface(['function example((address target,uint256 value)[] actions,int16 delta,bool vote)']);
  const f = iface.getFunction('example');
  assert.deepEqual(abiValue(f.inputs[0], [{ target: A, value: '9007199254740993' }]), [[A, 9007199254740993n]]);
  assert.equal(abiValue(f.inputs[1], '-9'), -9n); assert.equal(abiValue(f.inputs[2], 'false'), false);
  assert.throws(() => abiValue(f.inputs[0], Array(10001).fill([])));
  assert.equal(formArgs('DAOShip', 'submitVote', { 0: '12', 1: 'true' }), '["12",true]');
});
test('generic write encoding covers DAO, token, vault and all eight navigator interfaces', async t => {
  const ctx = await context(t);
  for (const kind of sdk.NAVIGATOR_KINDS) {
    const method = contractMethods(kind).find(m => m.effect === 'write' && m.inputs.length === 0) ?? contractMethods(kind).find(m => m.name === 'cancelPoll');
    assert.ok(method, kind);
    const call = await execute(ctx, findCommand('contract encode'), { kind, address: B, method: method.signature, args: method.inputs.map(() => '1') });
    assert.equal(call.to, B); assert.match(call.data, /^0x[\da-f]+$/i);
  }
  for (const [kind, method, args] of [['DAOShip', 'submitVote', ['1', true]], ['SharesERC20', 'approve', [A, '9007199254740993']], ['QuaiVault', 'enableModule', [D]]]) {
    const call = await execute(ctx, findCommand('contract encode'), { kind, address: B, method, args });
    assert.equal(new Interface(sdk.CONTRACT_ABIS[kind]).parseTransaction(call).name, method);
  }
  await assert.rejects(execute(ctx, findCommand('contract encode'), { kind: 'DAOShip', address: B, method: 'submitVote', args: ['4294967296', true] }));
  await assert.rejects(execute(ctx, findCommand('contract encode'), { kind: 'SignalNavigator', address: B, method: 'createPoll', args: ['poll', '1', '0', '60'] }));
});
test('unknown fields and malformed input fail before a command can run', async t => {
  const ctx = await context(t); let called = false;
  const command = { ...findCommand('proposal vote'), run: () => { called = true; } };
  for (const raw of [{ proposal: '1', vote: 'maybe' }, { proposal: '1', vote: 'yes', surprise: 1 }, { vote: 'yes' }]) await assert.rejects(execute(ctx, command, raw));
  assert.equal(called, false);
});
test('named proposal commands preserve the SDK sender and parameter ordering', async t => {
  const ctx = await context(t); ctx.config.daos.orchard = B; const calls = [];
  const chain = Object.fromEntries(['prepareVote', 'prepareProcess', 'prepareSponsor', 'prepareCancel', 'prepareSubmit', 'prepareRagequit'].map(name => [name, async (...args) => { calls.push([name, ...args]); return prepared(); }]));
  override(ctx, { chain });
  await execute(ctx, findCommand('proposal vote'), { proposal: '7', vote: 'yes' });
  await execute(ctx, findCommand('proposal process'), { proposal: '7', actions: [{ to: D, data: '0x', value: '0' }] });
  await execute(ctx, findCommand('dao ragequit'), { shares: '10', loot: '2', tokens: [ZeroAddress] });
  assert.deepEqual(calls[0], ['prepareVote', B, 7, true, A]);
  assert.deepEqual(calls[1].slice(0, 4), ['prepareProcess', B, 7, A]);
  assert.deepEqual(calls[2], ['prepareRagequit', B, A, A, 10n, 2n, [ZeroAddress]]);
});
test('unknown wallet profiles and mismatched RPC chains fail explicitly', async t => {
  const ctx = await context(t, { wallet: 'missing' }); assert.throws(() => ctx.from(), { code: 'CONFIG' });
  await assert.rejects(ctx.key(), { code: 'CONFIG' });
  override(ctx, { provider: { getNetwork: async () => ({ chainId: 9n }) } });
  await assert.rejects(ctx.assertNetwork(), { code: 'CHAIN_MISMATCH' });
});
test('RPC cancellation prevents a queued operation from starting', async t => {
  const ctx = await context(t); let calls = 0; ctx.abort.abort();
  await assert.rejects(ctx.rpc(async () => { calls++; })); assert.equal(calls, 0);
});
test('invalid gas, value and review bounds fail before opening a wallet or RPC', async t => {
  for (const flags of [{ maxGas: '0' }, { maxGas: '-1' }, { maxValue: '1.5' }, { expectHash: 'bad' }]) await assert.rejects(context(t, flags), { code: 'USAGE' });
});
test('native CREATE grinding and serialized plans round trip through SDK validation', async () => {
  const kind = 'VestingNavigator', config = navigatorConfig(kind, { daoShip: D, name: 'Vesting', description: 'Member vesting' });
  const data = sdk.encodeNavigatorDeployment(kind, '0x6000', config);
  const grind = await grindCreation(A, 0, data);
  assert.ok(sdk.isCyprus1Address(grind.expectedAddress));
  const plan = sdk.buildNavigatorDeploymentPlan({ chainId: 15000, from: A, vault: B, kind, config, bytecode: '0x6000', ...grind });
  assert.equal(readPlan(JSON.parse(json(plan))).id, plan.id);
  assert.equal(readPlan({ schemaVersion: 1, ok: true, data: { plan: JSON.parse(json(plan)) } }).id, plan.id);
  assert.throws(() => readPlan({ ...JSON.parse(json(plan)), id: '0x' + '00'.repeat(32) }), { code: 'PLAN_CHANGED' });
  assert.throws(() => navigatorConfig(kind, { ...config, arbitrary: true }));
});
test('receipt results expose exact named fields and ignore other emitters', () => {
  const iface = new Interface(sdk.CONTRACT_ABIS.SharesERC20), event = iface.encodeEventLog(iface.getEvent('Transfer'), [A, B, 9007199254740993n]);
  const receipt = { status: 1, logs: [{ address: D, ...event }, { address: B, ...event }] };
  const parsed = receiptEvents('SharesERC20', B, receipt);
  assert.deepEqual(parsed.map(e => e.args), [{ from: A, to: B, value: 9007199254740993n }]);
});
