import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, QuaiTransaction, Wallet, toBeHex } from 'quais';
import * as sdk from '@daoships/sdk';
import { deployNavigator, readPlan, grindCreation, recoverCreation, creationKey } from '../dist/deployments.js';
import { claimOperation } from '../dist/actions.js';
import { json } from '../dist/values.js';
import { B, D, BLOCK, context, override } from './helpers.mjs';

// Public, synthetic test key; never connected to a public network or funded wallet.
let wallet;
for (let n = 1; n < 10000; n++) { const candidate = new Wallet(toBeHex(n, 32)); if (sdk.isCyprus1Address(candidate.address)) { wallet = candidate; break; } }
assert.ok(wallet);
async function fixture(t, flags = {}) {
  const ctx = await context(t, { from: wallet.address, send: true, yes: true, id: 'create-one', ...flags });
  const config = { daoShip: D, name: 'Vesting', description: 'Member vesting' }, bytecode = '0x6000';
  const grind = await grindCreation(wallet.address, 0, sdk.encodeNavigatorDeployment('VestingNavigator', bytecode, config));
  const plan = sdk.buildNavigatorDeploymentPlan({ chainId: 15000, from: wallet.address, vault: B, kind: 'VestingNavigator', config, bytecode, ...grind });
  const state = { broadcasts: 0, receipt: null, tx: null, pendingNonce: 0, gas: 100n, failBroadcast: false };
  const dao = new Interface(sdk.CONTRACT_ABIS.DAOShip), nav = new Interface(sdk.CONTRACT_ABIS.VestingNavigator);
  const provider = { getNetwork: async () => ({ chainId: 15000n }), getTransactionCount: async () => state.pendingNonce,
    getBlock: async (_s, tag) => ({ hash: BLOCK, woHeader: { number: tag === 'latest' ? 5 : tag } }),
    getCode: async a => a === plan.expectedAddress && !state.receipt ? '0x' : '0x6000',
    call: async request => dao.encodeFunctionResult('avatar', [B]), estimateGas: async () => state.gas,
    getTransaction: async () => state.tx, getTransactionReceipt: async () => state.receipt, waitForTransaction: async () => state.receipt,
    broadcastTransaction: async (_zone, signed) => {
      state.broadcasts++;
      const tx = QuaiTransaction.from(signed); state.tx = tx;
      const marker = ctx.store.get(creationKey(ctx.flags.id)); assert.equal(marker.status, 'broadcasting'); assert.equal(marker.hash, tx.hash);
      if (state.failBroadcast) throw Error('acknowledgement lost');
      const event = nav.encodeEventLog(nav.getEvent('NavigatorDeployed'), [D, wallet.address, plan.kind, config.name, config.description]);
      state.receipt = { hash: tx.hash, status: 1, from: wallet.address, to: null, contractAddress: plan.expectedAddress, blockNumber: 3, blockHash: BLOCK, logs: [{ address: plan.expectedAddress, ...event }] };
      return { hash: tx.hash };
    },
  };
  const signer = { address: wallet.address, populateQuaiTransaction: async request => ({ ...request, type: 0, gasPrice: 1n, accessList: [] }), signTransaction: request => wallet.signTransaction(request) };
  override(ctx, { provider, signer: async () => signer });
  return { ctx, plan, state, signer };
}
test('navigator preview checks prerequisites without signing', async t => {
  const f = await fixture(t, { send: false }); f.ctx.signer = () => { throw Error('must not sign'); };
  const result = await deployNavigator(f.ctx, f.plan); assert.equal(result.mode, 'preview'); assert.equal(result.transaction.to, f.plan.expectedAddress);
  assert.equal(f.ctx.store.documents('creation:').length, 0); assert.equal(f.state.broadcasts, 0);
});
test('native CREATE persists the signed hash before broadcast and verifies constructor provenance', async t => {
  const f = await fixture(t); const result = await deployNavigator(f.ctx, f.plan);
  assert.equal(result.mode, 'mined'); assert.equal(result.address, f.plan.expectedAddress); assert.equal(f.state.broadcasts, 1);
  assert.equal((await f.ctx.store.read(sdk.recoveryAccountKey(15000, wallet.address))).blockedBy, null);
  const saved = f.ctx.store.get(creationKey('create-one')); assert.equal(saved.status, 'mined');
  assert.equal(json(saved).includes('privateKey'), false); assert.equal(readPlan(saved.plan).id, f.plan.id);
  const repeated = await deployNavigator(f.ctx, f.plan); assert.equal(repeated.outcome, 'mined'); assert.equal(f.state.broadcasts, 1);
});
test('lost CREATE acknowledgement leaves a known signed hash and quarantines the account', async t => {
  const f = await fixture(t); f.state.failBroadcast = true;
  await assert.rejects(deployNavigator(f.ctx, f.plan), error => error.code === 'TX_PENDING' && !!error.details.hash);
  assert.equal((await f.ctx.store.read(sdk.recoveryAccountKey(15000, wallet.address))).blockedBy, 'create-one');
  await assert.rejects(recoverCreation(f.ctx, 'create-one', true), { code: 'RECOVERY_BLOCKED' });
  assert.equal((await recoverCreation(f.ctx, 'create-one')).outcome, 'pending'); assert.equal(f.state.broadcasts, 1);
  await assert.rejects(deployNavigator(f.ctx, f.plan), error => error.code === 'TX_PENDING' && error.exitCode === 4);
  assert.equal(f.state.broadcasts, 1);
});
test('failed deployment preparation and review mismatches cannot broadcast', async t => {
  const f = await fixture(t); f.state.pendingNonce = 1;
  await assert.rejects(deployNavigator(f.ctx, f.plan), { code: 'PLAN_CHANGED' });
  f.state.pendingNonce = 0; f.ctx.flags.expectHash = '0x' + '00'.repeat(32);
  await assert.rejects(deployNavigator(f.ctx, f.plan), { code: 'PLAN_CHANGED' });
  f.ctx.flags.expectHash = undefined; f.state.gas = 10000001n;
  await assert.rejects(deployNavigator(f.ctx, f.plan), { code: 'LIMIT' }); assert.equal(f.state.broadcasts, 0);
});
test('signing failure releases a CREATE reservation while preserving its unsent record', async t => {
  const f = await fixture(t); f.signer.signTransaction = () => { throw Error('signer declined'); };
  await assert.rejects(deployNavigator(f.ctx, f.plan)); assert.equal(f.state.broadcasts, 0);
  assert.equal(f.ctx.store.get(creationKey('create-one')).status, 'not_sent');
  assert.equal((await f.ctx.store.read(sdk.recoveryAccountKey(15000, wallet.address))).nextNonce, 0);
});
test('regular transactions and CREATE share a single operation-ID namespace', async t => {
  const ctx = await context(t); claimOperation(ctx, 'same', 'transaction', 'hash1');
  assert.throws(() => claimOperation(ctx, 'same', 'creation', 'hash2'), { code: 'RECOVERY_CONFLICT' });
});
