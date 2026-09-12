import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'quais';
import { CONTRACT_ABIS, ProposalState } from '@daoships/sdk';
import { assertBusinessOutcome } from '../dist/outcomes.js';
import { transact } from '../dist/actions.js';
import { execute, findCommand } from '../dist/commands.js';
import { spawnCommand } from '../dist/tui/child.js';
import { context, prepared, transport, override, A, B, D, HASH } from './helpers.mjs';

const vault = new Interface(CONTRACT_ABIS.QuaiVault), token = new Interface(CONTRACT_ABIS.SharesERC20);
const event = (iface, name, args, address = B) => ({ address, ...iface.encodeEventLog(iface.getEvent(name), args) });
const dao = new Interface(CONTRACT_ABIS.DAOShip);
test('defeated closure succeeds only for empty action data; failed execution and retention veto remain errors', () => {
  const tx = { from: A, to: B, data: dao.encodeFunctionData('processProposal', [7, '0x']) };
  const receipt = { status: 1, logs: [event(dao, 'ProcessProposal', [7, false, false, A])] };
  assert.doesNotThrow(() => assertBusinessOutcome(tx, receipt));
  assert.throws(() => assertBusinessOutcome({ ...tx, data: dao.encodeFunctionData('processProposal', [7, '0x1234']) }, receipt), { code: 'PROPOSAL_DEFEATED' });
  assert.throws(() => assertBusinessOutcome(tx, { status: 1, logs: [event(dao, 'ProcessProposal', [7, true, true, A])] }), { code: 'ACTION_FAILED' });
  for (const logs of [[], [event(dao, 'ProcessProposal', [8, false, false, A])], [event(dao, 'ProcessProposal', [7, false, false, A], D)]]) {
    assert.throws(() => assertBusinessOutcome(tx, { status: 1, logs }), { code: 'MISSING_EVENT' });
  }
});
test('named and generic proposal closure verify the outcome and recover without another send', async t => {
  for (const generic of [false, true]) {
    const ctx = await context(t, { dao: B, send: true, yes: true, id: 'defeated-close' });
    const tx = prepared({ data: dao.encodeFunctionData('processProposal', [7, '0x']), operation: 'processProposal' });
    const f = transport(ctx, tx);
    f.receipt.logs = [event(dao, 'ProcessProposal', [7, false, false, A])];
    override(ctx, { indexer: { getProposalDetails: () => assert.fail('Closure must not require indexed calldata') }, chain: {
      getProposal: async () => ({ state: ProposalState.Defeated }),
      prepareProcess: async (address, id, from, data) => { assert.equal(address, B); assert.equal(id, 7); assert.equal(from, A); assert.equal(data, undefined); return tx; },
      prepareCall: async call => { assert.equal(call.data, tx.data); return tx; },
    } });
    const result = generic
      ? await execute(ctx, findCommand('contract write'), { kind: 'DAOShip', address: B, method: 'processProposal', args: ['7', '0x'] })
      : await execute(ctx, findCommand('proposal process'), { proposal: '7' });
    assert.equal(result.mode, 'mined');
    if (!generic) assert.deepEqual(result.result, { proposalId: 7, outcome: 'defeated', executed: false, closed: true });
    assert.equal((await execute(ctx, findCommand('tx recover'), { id: 'defeated-close' })).outcome, 'mined');
    assert.equal(f.calls.length, 1);
  }
});
test('ready proposal processing still requires committed data and refreshes indexed input', async t => {
  const ctx = await context(t, { dao: B }); let indexedData = null, preparations = 0;
  override(ctx, { indexer: { getProposalDetails: async () => ({ proposal_data: indexedData }) }, chain: {
    getProposal: async () => ({ state: ProposalState.Ready }),
    prepareProcess: async (_address, _id, _from, data) => { preparations++; assert.equal(data, '0x1234'); return prepared(); },
  } });
  await assert.rejects(execute(ctx, findCommand('proposal process'), { proposal: '7' }), { code: 'USAGE' });
  assert.equal(preparations, 0);
  indexedData = '0x1234';
  assert.equal((await execute(ctx, findCommand('proposal process'), { proposal: '7' })).mode, 'preview');
  assert.equal(preparations, 1);
});
test('vault inner execution failures never become success and only the exact emitter counts', () => {
  const data = vault.encodeFunctionData('execTransactionFromModule(address,uint256,bytes)', [D, 0n, '0x']);
  const tx = { from: A, to: B, data }, failure = event(vault, 'ExecutionFromModuleFailure', [A]);
  assert.throws(() => assertBusinessOutcome(tx, { status: 1, logs: [failure] }), { code: 'ACTION_FAILED' });
  assert.throws(() => assertBusinessOutcome(tx, { status: 1, logs: [{ ...failure, address: D }] }), { code: 'MISSING_EVENT' });
  assert.doesNotThrow(() => assertBusinessOutcome(tx, { status: 1, logs: [event(vault, 'ExecutionFromModuleSuccess', [A]), { ...failure, address: D }] }));
  const execute = { ...tx, data: vault.encodeFunctionData('executeTransaction', [HASH]) };
  assert.throws(() => assertBusinessOutcome(execute, { status: 1, logs: [event(vault, 'TransactionFailed', [HASH, A, '0x'])] }), { code: 'ACTION_FAILED' });
});
test('generic token calls require matching amounts, participants and events', () => {
  const amount = 9007199254740993n;
  for (const [method, args, name, eventArgs] of [
    ['transfer', [D, amount], 'Transfer', [A, D, amount]],
    ['transferFrom', [A, D, amount], 'Transfer', [A, D, amount]],
    ['approve', [D, amount], 'Approval', [A, D, amount]],
    ['delegate', [D], 'DelegateChanged', [A, B, D]],
  ]) {
    const tx = { from: A, to: B, data: token.encodeFunctionData(method, args) };
    assert.throws(() => assertBusinessOutcome(tx, { status: 1, logs: [] }), { code: 'MISSING_EVENT' });
    assert.doesNotThrow(() => assertBusinessOutcome(tx, { status: 1, logs: [event(token, name, eventArgs)] }));
    assert.throws(() => assertBusinessOutcome(tx, { status: 1, logs: [event(token, name, eventArgs, D)] }), { code: 'MISSING_EVENT' });
  }
});
test('recovery repeats business checks, preserves the hash and does not broadcast again', async t => {
  const ctx = await context(t, { send: true, yes: true, id: 'vault-failed' });
  const tx = prepared({ data: vault.encodeFunctionData('executeTransaction', [HASH]) }), f = transport(ctx, tx);
  f.receipt.logs = [event(vault, 'TransactionFailed', [HASH, A, '0x'])];
  await assert.rejects(transact(ctx, f.action), e => e.code === 'ACTION_FAILED' && e.details.hash === HASH);
  await assert.rejects(execute(ctx, findCommand('tx recover'), { id: 'vault-failed' }), e => e.code === 'ACTION_FAILED' && e.details.hash === HASH);
  assert.equal(f.calls.length, 1);
});
test('TUI child preserves explicit DAO context and original failure exit codes', async t => {
  const ctx = await context(t, { dao: D }); ctx.config.daos.orchard = B; ctx.save();
  const result = await spawnCommand(ctx, findCommand('governance encode'), { data: { method: 'lockAdmin' } }, ctx.signal);
  assert.equal(result.to, D);
  await assert.rejects(spawnCommand(ctx, findCommand('wallet verify'), { name: 'missing' }, ctx.signal), e => e.code === 'KEYSTORE' && e.exitCode === 3);
});
