import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '../dist/context.js';
export const A = '0x0011111111111111111111111111111111111111';
export const B = '0x0022222222222222222222222222222222222222';
export const D = '0x0033333333333333333333333333333333333333';
export const HASH = '0x' + '11'.repeat(32), BLOCK = '0x' + '33'.repeat(32);
export async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'daoships-cli-test-'));
  t.after(() => rm(path, { recursive: true, force: true })); return path;
}
export async function context(t, flags = {}) {
  const ctx = await Context.open({ configDir: await directory(t), from: A, network: 'orchard', timeout: 1000, ...flags });
  t.after(() => ctx.close()); return ctx;
}
export function override(target, values) { for (const [key, value] of Object.entries(values)) Object.defineProperty(target, key, { configurable: true, value, writable: true }); }
export function transport(ctx, prepared, status = 1) {
  const calls = [], transactions = new Map();
  const receipt = { hash: HASH, status, from: A, to: B, blockHash: BLOCK, blockNumber: 3, logs: [] };
  const provider = { getNetwork: async () => ({ chainId: 15000n }), getTransactionCount: async () => 0,
    getTransaction: async hash => transactions.get(hash) ?? null, getTransactionReceipt: async hash => transactions.has(hash) ? receipt : null,
    getBlock: async (_shard, tag) => ({ hash: BLOCK, woHeader: { number: tag === 'latest' ? 6 : tag } }) };
  const wallet = { provider, getAddress: async () => A, estimateGas: async () => 100n, async sendTransaction(request) {
    calls.push(request); transactions.set(HASH, { ...request, hash: HASH });
    return { hash: HASH, wait: async () => receipt };
  } };
  override(ctx, { provider, signer: async () => wallet });
  return { calls, wallet, provider, receipt, action: { prepare: async () => prepared } };
}
export const prepared = (patch = {}) => ({ chainId: 15000, from: A, to: B, data: '0x1234', value: 0n, operation: 'example', checkedAt: { blockNumber: 3, blockHash: BLOCK }, ...patch });
