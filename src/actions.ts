import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { keccak256, toUtf8Bytes, id as signatureHash, type QuaiTransactionResponse } from 'quais';
import { sendRecoverableTransaction, waitForRecoveryTransaction, inspectRecoveryTransaction, recoveryTransactionKey,
  type PreparedTransaction, type Receipt } from '@daoships/sdk';
import type { Context } from './context.js';
import { CliError, amount, json, errorInfo } from './values.js';
import { assertBusinessOutcome } from './outcomes.js';

export interface Action {
  prepare(): Promise<PreparedTransaction>;
  finish?(receipt: Receipt): unknown | Promise<unknown>;
}
export function reviewHash(tx: Pick<PreparedTransaction, 'chainId' | 'from' | 'to' | 'data' | 'value'>): string {
  return keccak256(toUtf8Bytes(json({ chainId: tx.chainId, from: tx.from.toLowerCase(), to: tx.to.toLowerCase(), data: tx.data.toLowerCase(), value: tx.value })));
}
export async function consent(ctx: Context, review: unknown): Promise<void> {
  if (ctx.flags.yes) return;
  if (!process.stdin.isTTY || !process.stderr.isTTY || ctx.flags.json) throw new CliError('CONSENT_REQUIRED', 'Execution requires --yes; omit --send to preview first.', {}, 3);
  process.stderr.write(json(review, true) + '\n');
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try { if ((await prompt.question('Send this transaction? [y/N] ', { signal: ctx.signal })).toLowerCase() !== 'y') throw new CliError('DECLINED', 'Transaction declined.', {}, 5); }
  finally { prompt.close(); }
}
export function claimOperation(ctx: Context, id: string, kind: 'transaction' | 'creation', hash: string): void {
  const key = `operation:${id}`, claim = { kind, hash };
  if (!ctx.store.insert(key, claim) && json(ctx.store.get(key)) !== json(claim)) throw new CliError('RECOVERY_CONFLICT', 'Operation ID is already bound to another intent.', { id }, 3);
}
export async function transact(ctx: Context, action: Action): Promise<unknown> {
  const prepared = await action.prepare(), hash = reviewHash(prepared);
  if (ctx.flags.expectHash && ctx.flags.expectHash.toLowerCase() !== hash) throw new CliError('PLAN_CHANGED', 'The prepared transaction differs from the reviewed hash.', { expected: ctx.flags.expectHash, actual: hash }, 3);
  if (ctx.flags.maxValue !== undefined && prepared.value > amount(ctx.flags.maxValue)) throw new CliError('LIMIT', 'Transaction exceeds --max-value.', {}, 3);
  const preview = { mode: 'preview', reviewHash: hash, transaction: prepared, fees: 'Network fees are additional; no transaction has been submitted.' };
  if (!ctx.flags.send) return preview;
  if (!ctx.flags.id && !process.stdin.isTTY) throw new CliError('USAGE', 'Non-interactive sends require a stable --id for recovery.');
  const id = ctx.flags.id ?? randomUUID();
  if (ctx.store.get(`creation:${id}`)) throw new CliError('RECOVERY_CONFLICT', 'ID belongs to a navigator deployment.', { id }, 3);
  const saved = await ctx.store.read(recoveryTransactionKey(id));
  let changed = false, observed;
  if (saved) {
    if (saved.kind !== 'transaction' || reviewHash(saved.intent) !== hash) throw new CliError('RECOVERY_CONFLICT', 'This ID already belongs to a different transaction.', { id }, 3);
    if (!saved.hash) throw new CliError('TX_PENDING', 'This operation already has durable intent. Inspect it with tx show/recover before taking further action.', { id, status: saved.status }, 4);
    observed = await inspectRecoveryTransaction(ctx.store, ctx.provider, id, { confirmations: ctx.confirmations, timeoutMs: ctx.timeout });
  } else {
    await consent(ctx, { id, ...preview });
    claimOperation(ctx, id, 'transaction', hash);
    const wallet = await ctx.signer();
    const multiplier = prepared.data.slice(0, 10) === signatureHash('processProposal(uint32,bytes)').slice(0, 10) ? 150n : 120n;
    let gasLimitFailure: CliError | undefined;
    const signer = { provider: wallet.provider, getAddress: () => wallet.getAddress(), async estimateGas(request: Parameters<typeof wallet.estimateGas>[0]) {
      const estimate = await wallet.estimateGas(request);
      const gasLimit = (estimate * multiplier + 99n) / 100n, maximumGas = amount(ctx.flags.maxGas ?? '10000000');
      if (gasLimit > maximumGas) {
        gasLimitFailure = new CliError('LIMIT', 'Gas limit exceeds --max-gas; no transaction was sent.', { id, estimatedGas: estimate, gasLimit, maximumGas }, 3);
        throw gasLimitFailure;
      }
      return estimate;
    }, sendTransaction: (request: Parameters<typeof wallet.sendTransaction>[0]) => wallet.sendTransaction(request) };
    let sent;
    try { sent = await sendRecoverableTransaction(prepared, signer, { id, store: ctx.store, refresh: action.prepare, gasMultiplierPercent: multiplier, timeoutMs: ctx.timeout, signal: ctx.signal }); }
    catch (error) {
      const info = errorInfo(error);
      if (gasLimitFailure && info.code === 'CHAIN_ERROR') throw gasLimitFailure;
      throw new CliError(info.code, info.message, { ...info.details, id }, info.exitCode);
    }
    changed = true;
    process.stderr.write(json({ event: 'submitted', id, hash: sent.transaction.hash }) + '\n');
    try { observed = await ctx.rpc(() => waitForRecoveryTransaction(ctx.store, ctx.provider, id, sent.transaction as QuaiTransactionResponse, { confirmations: ctx.confirmations, timeoutMs: ctx.timeout })); }
    catch (error) { const info = errorInfo(error); throw new CliError(info.exitCode === 130 ? 'ABORTED' : 'TX_PENDING', 'Confirmation stopped. Reconcile the recorded transaction before retrying.', { id, hash: sent.transaction.hash }, info.exitCode === 130 ? 130 : 4); }
  }
  if (observed.outcome !== 'mined') throw new CliError(observed.outcome === 'reverted' ? 'TX_REVERTED' : 'TX_PENDING', 'Inspect the recorded transaction before submitting another operation.', { id, hash: observed.record.hash, outcome: observed.outcome }, observed.outcome === 'reverted' ? 3 : 4);
  const receipt = await ctx.rpc(() => ctx.provider.getTransactionReceipt(observed.record.receipt!.hash));
  if (!receipt) throw new CliError('TX_PENDING', 'Receipt is temporarily unavailable.', { id, hash: observed.record.hash }, 4);
  let result;
  try { assertBusinessOutcome(prepared, receipt); result = action.finish ? await action.finish(receipt) : undefined; }
  catch (error) { const info = errorInfo(error); throw new CliError(info.code, info.message, { ...info.details, id, hash: receipt.hash }, info.exitCode); }
  return { mode: 'mined', changed, id, hash: receipt.hash, blockNumber: receipt.blockNumber, result };
}
