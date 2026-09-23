import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { ContractFactory, Interface, QuaiTransaction, Zone, keccak256, toUtf8Bytes } from 'quais';
import * as sdk from '@daoships/sdk';
import type { Context } from './context.js';
import { claimOperation, consent, transact } from './actions.js';
import { CliError, abiValue, amount, fail, integer, json } from './values.js';

type ObjectInput = Record<string, unknown>;
function object(input: unknown): ObjectInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('Expected a JSON object.');
  return input as ObjectInput;
}
const options = (ctx: Context) => ({ timeoutMs: ctx.timeout, signal: ctx.signal, confirmations: ctx.confirmations });
export function navigatorKind(value: unknown): sdk.NavigatorKind {
  if (!sdk.NAVIGATOR_KINDS.includes(value as sdk.NavigatorKind)) return fail('Select one of the eight navigator kinds.');
  return value as sdk.NavigatorKind;
}
export function navigatorConfig(kind: sdk.NavigatorKind, input: unknown): sdk.NavigatorDeployConfig[sdk.NavigatorKind] {
  const raw = object(input), fields = new Interface(sdk.CONTRACT_ABIS[kind]).deploy.inputs;
  const config = Object.fromEntries(fields.map(p => { const key = p.name.replace(/^_/, ''); return [key, abiValue(p, raw[key])]; })) as unknown as sdk.NavigatorDeployConfig[sdk.NavigatorKind];
  for (const key of Object.keys(raw)) if (!fields.some(p => p.name.replace(/^_/, '') === key)) return fail(`Unknown constructor field: ${key}.`);
  sdk.navigatorDeploymentArgs(kind, config); return config;
}
export function governanceConfig(input: unknown): sdk.GovernanceConfig {
  const p = object(input);
  const config = Object.fromEntries(['votingPeriod', 'gracePeriod', 'defaultExpiryWindow', 'proposalOffering', 'quorumPercent', 'sponsorThreshold', 'minRetentionPercent'].map(k => [k, ['votingPeriod', 'gracePeriod', 'defaultExpiryWindow'].includes(k) ? integer(p[k], k) : amount(p[k])])) as unknown as sdk.GovernanceConfig;
  sdk.validateGovernanceConfig(config); return config;
}
function launchParameters(input: unknown): sdk.LaunchParams {
  const p = object(input), init = object(p.initialization);
  return { ...p, sharesSalt: amount(p.sharesSalt), lootSalt: amount(p.lootSalt), daoShipSalt: amount(p.daoShipSalt), initialization: {
    ...init, governanceConfig: governanceConfig(init.governanceConfig),
    navigatorPermissions: (init.navigatorPermissions as unknown[]).map(amount), initShareAmounts: (init.initShareAmounts as unknown[]).map(amount), initLootAmounts: (init.initLootAmounts as unknown[]).map(amount),
  } } as unknown as sdk.LaunchParams;
}
/** Rebuild serialized plans with the SDK; never trust supplied calls, predictions or steps. */
export function readPlan(input: unknown): sdk.DeploymentWorkflowPlan {
  let p = object(input);
  if (p.schemaVersion === 1 && p.ok === true) p = object(p.data);
  if (p.plan) p = object(p.plan);
  let plan: sdk.DeploymentWorkflowPlan;
  if (p.type === 'dao-launch') {
    const base = { chainId: integer(p.chainId, 'chainId'), from: String(p.from), deployment: p.deployment as sdk.DeploymentContracts, parameters: launchParameters(p.parameters) };
    const vault = p.newVault ? object(p.newVault) : undefined;
    plan = sdk.buildDAOShipLaunchPlan(vault ? { ...base, route: 'new-vault', vaultOwners: vault.owners as string[], vaultThreshold: amount(vault.threshold), vaultSalt: amount(vault.salt), vaultProxyBytecode: String(vault.proxyBytecode) }
      : { ...base, route: p.route as 'direct' | 'existing-vault', existingVault: String(object(p.expected).vault) });
  } else if (p.type === 'navigator') {
    const kind = navigatorKind(p.kind);
    plan = sdk.buildNavigatorDeploymentPlan({ ...p, kind, config: navigatorConfig(kind, p.config),
      ...(p.treasuryFunding ? { treasuryFunding: { ...object(p.treasuryFunding), amount: amount(object(p.treasuryFunding).amount) } } : {}),
    } as unknown as sdk.NavigatorWorkflowInput<typeof kind>);
  } else return fail('Expected an SDK DAO launch or navigator deployment plan.');
  if (plan.id !== p.id || p.addressPolicy !== 'cyprus1') throw new CliError('PLAN_CHANGED', 'Serialized plan identity differs from its rebuilt intent.', {}, 3);
  return plan;
}
export async function launchPlan(ctx: Context, input: unknown): Promise<sdk.DAOShipLaunchPlan> {
  const p = object(input), parameters = object(p.parameters), initialization = object(parameters.initialization);
  const discovered = await sdk.discoverDeployment(ctx.provider, { chainId: ctx.chainId, launcher: ctx.resolve(String(p.launcher)), ...options(ctx) });
  const deployment = discovered.contracts, from = ctx.from();
  const route = p.route ?? 'existing-vault';
  if (!['direct', 'existing-vault', 'new-vault'].includes(String(route))) return fail('Invalid launch route.');
  const base = { ...p, vaultSalt: p.vaultSalt, chainId: ctx.chainId, from, deployment, parameters: { ...parameters, initialization: { ...initialization, multisendLibrary: deployment.multisendCallOnly } } };
  if ([parameters.sharesSalt, parameters.lootSalt, parameters.daoShipSalt].some(v => v === undefined) || (route === 'new-vault' && p.vaultSalt === undefined)) {
    const mined = await sdk.mineDAOShipSalts({ factory: deployment.daoShipLauncher, sender: route === 'direct' ? from : deployment.daoShipAndVaultLauncher,
      singletons: { shares: deployment.sharesSingleton, loot: deployment.lootSingleton, daoShip: deployment.daoShipSingleton }, startSalt: amount(p.startSalt ?? '0'), maxAttempts: 100_000, signal: ctx.signal,
      ...(route === 'new-vault' ? { vault: { factory: deployment.quaiVaultFactory, implementation: deployment.vaultSingleton, owners: p.vaultOwners as string[], threshold: amount(p.vaultThreshold), proxyBytecode: String(p.vaultProxyBytecode), multisendCallOnly: deployment.multisendCallOnly } } : {}),
    });
    Object.assign(base.parameters, { sharesSalt: mined.shares.salt, lootSalt: mined.loot.salt, daoShipSalt: mined.daoShip.salt });
    if (mined.vault) base.vaultSalt = mined.vault.salt;
  }
  return sdk.buildDAOShipLaunchPlan({ ...base, route, parameters: launchParameters(base.parameters),
    ...(route === 'new-vault' ? { vaultThreshold: amount(p.vaultThreshold), vaultSalt: amount(base.vaultSalt) } : {}),
  } as sdk.DAOShipLaunchInput);
}
export async function executeLaunch(ctx: Context, input: unknown): Promise<unknown> {
  const plan = readPlan(input); if (plan.type !== 'dao-launch') return fail('Expected a DAO launch plan.');
  checkIdentity(ctx, plan);
  return transact(ctx, { prepare: () => sdk.prepareDAOShipLaunch(plan, ctx.provider, options(ctx)), async finish(receipt) {
    await sdk.verifyDeploymentWorkflowStep(plan, 'launch', receipt as sdk.DeploymentExecutionReceipt, ctx.provider, options(ctx));
    ctx.config.daos[ctx.network] = plan.expected.daoShip; ctx.save();
    return { ...plan.expected, remainingSteps: plan.steps.filter(s => s.id !== 'launch'), plan };
  } });
}
export function checkIdentity(ctx: Context, plan: sdk.DeploymentWorkflowPlan): void {
  if (plan.chainId !== ctx.chainId) throw new CliError('CHAIN_MISMATCH', 'Plan belongs to another network.', {}, 3);
  if (plan.from.toLowerCase() !== ctx.from().toLowerCase()) throw new CliError('SIGNER_MISMATCH', 'Plan belongs to another sender.', {}, 3);
}
export async function grindCreation(from: string, nonce: number, data: string, signal?: AbortSignal) {
  for (let attempt = 0; attempt < 100_000; attempt++) {
    signal?.throwIfAborted();
    const salt = '0x' + attempt.toString(16).padStart(8, '0'), creationData = data + salt.slice(2);
    const expectedAddress = ContractFactory.getContractAddress({ from, nonce: BigInt(nonce), data: creationData });
    if (sdk.isCyprus1Address(expectedAddress)) return { expectedAddress, quaiCreation: { nonce, salt }, creationData };
    if (attempt % 100 === 99) await setImmediate();
  }
  throw new CliError('LIMIT', 'No Cyprus-1 CREATE address found within the search bound.');
}
export async function navigatorPlan(ctx: Context, kind: sdk.NavigatorKind, raw: unknown, extra: unknown = {}): Promise<sdk.NavigatorDeploymentPlan> {
  const config = navigatorConfig(kind, raw), extras = object(extra), from = ctx.from();
  await ctx.assertNetwork();
  const [dao, nonce, { NAVIGATOR_BYTECODES }] = await Promise.all([ctx.chain.getDao(config.daoShip), ctx.rpc(() => ctx.provider.getTransactionCount(from, 'pending')), import('@daoships/sdk/bytecode')]);
  const bytecode = NAVIGATOR_BYTECODES[kind], grinded = await grindCreation(from, nonce, sdk.encodeNavigatorDeployment(kind, bytecode, config), ctx.signal);
  return sdk.buildNavigatorDeploymentPlan({ ...extras, chainId: ctx.chainId, from, kind, config, bytecode, vault: dao.avatar, ...grinded,
    ...(extras.treasuryFunding ? { treasuryFunding: { ...object(extras.treasuryFunding), amount: amount(object(extras.treasuryFunding).amount) } } : {}),
  } as sdk.NavigatorWorkflowInput<typeof kind>);
}
export interface CreationRecord {
  version: 1; id: string; revision: number; kind: 'creation'; plan: sdk.NavigatorDeploymentPlan;
  status: 'prepared' | 'broadcasting' | 'submitted' | 'mined' | 'reverted' | 'not_sent'; hash?: string;
}
export const creationKey = (id: string) => { sdk.recoveryTransactionKey(id); return `creation:${id}`; };
const detached = <T>(value: T): T => JSON.parse(json(value)) as T;
function updateCreation(ctx: Context, current: CreationRecord, patch: Partial<CreationRecord>): CreationRecord {
  const next = detached({ ...current, ...patch, revision: current.revision + 1 });
  if (!ctx.store.swapDocument(creationKey(current.id), current, next)) throw new CliError('RECOVERY_CONFLICT', 'Deployment changed concurrently.', { id: current.id }, 3);
  return next;
}
async function releaseCreation(ctx: Context, record: CreationRecord, sent: boolean): Promise<void> {
  const key = sdk.recoveryAccountKey(record.plan.chainId, record.plan.from), nonce = record.plan.quaiCreation!.nonce;
  for (let attempt = 0; attempt < 8; attempt++) {
    const current = await ctx.store.read(key);
    if (!current || current.kind !== 'nonce' || current.blockedBy !== record.id) return;
    const next = { ...current, revision: current.revision + 1, blockedBy: null, nextNonce: sent ? Math.max(current.nextNonce, nonce + 1) : current.nextNonce === nonce + 1 ? nonce : current.nextNonce };
    if (await ctx.store.compareAndSwap(key, current.revision, next)) return;
  }
  throw new CliError('RECOVERY_CONFLICT', 'Could not release the deployment nonce reservation.', { id: record.id }, 4);
}
export async function recoverCreation(ctx: Context, id: string, abandon = false): Promise<unknown> {
  let record = ctx.store.get<CreationRecord>(creationKey(id)); if (!record) return fail('Unknown deployment ID.');
  const plan = readPlan(record.plan) as sdk.NavigatorDeploymentPlan;
  if (plan.chainId !== ctx.chainId) throw new CliError('CHAIN_MISMATCH', 'Deployment belongs to another network.', {}, 3);
  if (abandon) {
    if (!['prepared', 'not_sent'].includes(record.status)) throw new CliError('RECOVERY_BLOCKED', 'A deployment that entered broadcasting cannot be abandoned.', { id }, 4);
    if (record.status === 'prepared') record = updateCreation(ctx, record, { status: 'not_sent' });
    await releaseCreation(ctx, record, false); return record;
  }
  if (record.status === 'not_sent') { await releaseCreation(ctx, record, false); return { outcome: 'not_sent', record }; }
  if (!record.hash) return { outcome: record.status === 'prepared' ? 'prepared' : 'unknown', record };
  await ctx.assertNetwork();
  const receipt = await ctx.rpc(() => ctx.provider.getTransactionReceipt(record!.hash!));
  if (!receipt) return { outcome: 'pending', record };
  if (receipt.status === 0) {
    const [tx, block, head] = await Promise.all([ctx.rpc(() => ctx.provider.getTransaction(record!.hash!)), ctx.block(receipt.blockNumber), ctx.head()]);
    if (!tx || !('from' in tx) || tx.chainId !== BigInt(ctx.chainId) || tx.from.toLowerCase() !== plan.from.toLowerCase() || tx.to !== null || tx.data.toLowerCase() !== plan.creationData.toLowerCase() || tx.nonce !== plan.quaiCreation!.nonce || tx.value !== 0n
      || receipt.hash !== record.hash || receipt.from.toLowerCase() !== plan.from.toLowerCase() || receipt.to !== null || block?.hash !== receipt.blockHash || block?.woHeader.number !== receipt.blockNumber || (head.number ?? 0) - receipt.blockNumber + 1 < ctx.confirmations) throw new CliError('TX_PENDING', 'Deployment receipt is not yet verified.', { id, hash: record.hash }, 4);
    record = updateCreation(ctx, record, { status: 'reverted' }); await releaseCreation(ctx, record, true); return { outcome: 'reverted', record };
  }
  await sdk.verifyDeploymentWorkflowStep(plan, 'create', receipt, ctx.provider, options(ctx));
  record = updateCreation(ctx, record, { status: 'mined' }); await releaseCreation(ctx, record, true);
  return { outcome: 'mined', record, address: plan.expectedAddress, remainingSteps: plan.steps.filter(s => s.id !== 'create') };
}
export async function deployNavigator(ctx: Context, plan: sdk.NavigatorDeploymentPlan): Promise<unknown> {
  checkIdentity(ctx, plan); if (!plan.quaiCreation) return fail('Navigator plan must include native Quai CREATE preparation.');
  const reviewHash = keccak256(toUtf8Bytes(plan.id));
  if (ctx.flags.expectHash && ctx.flags.expectHash !== reviewHash) throw new CliError('PLAN_CHANGED', 'Deployment differs from the reviewed plan.', {}, 3);
  const id = ctx.flags.id ?? randomUUID(), key = creationKey(id);
  if (ctx.flags.send) {
    if (!ctx.flags.id && !process.stdin.isTTY) return fail('Non-interactive deployment requires a stable --id.');
    const existing = ctx.store.get<CreationRecord>(key);
    if (existing) {
      if (existing.plan.id !== plan.id) throw new CliError('RECOVERY_CONFLICT', 'ID belongs to another deployment.', { id }, 3);
      const recovered = await recoverCreation(ctx, id) as { outcome: string; record: CreationRecord };
      if (recovered.outcome !== 'mined') throw new CliError(recovered.outcome === 'reverted' ? 'TX_REVERTED' : 'TX_PENDING', 'This deployment already has durable intent. Inspect its journal entry before proceeding.', { id, hash: recovered.record.hash, outcome: recovered.outcome }, recovered.outcome === 'reverted' ? 3 : 4);
      return { mode: 'mined', changed: false, id, hash: recovered.record.hash, ...recovered };
    }
    if (await ctx.store.read(sdk.recoveryTransactionKey(id))) throw new CliError('RECOVERY_CONFLICT', 'ID belongs to a regular transaction.', { id }, 3);
  }
  const prepared = await sdk.prepareDeploymentWorkflowStep(plan, 'create', ctx.provider, options(ctx));
  const gasEstimate = await ctx.rpc(() => ctx.provider.estimateGas({ from: plan.from, data: plan.creationData, nonce: plan.quaiCreation!.nonce, value: 0n }));
  const gasLimit = (gasEstimate * 120n + 99n) / 100n;
  if (gasLimit === 0n || gasLimit > amount(ctx.flags.maxGas ?? '10000000')) throw new CliError('LIMIT', 'Deployment exceeds --max-gas.', {}, 3);
  const preview = { mode: 'preview', reviewHash, transaction: { chainId: ctx.chainId, from: plan.from, to: plan.expectedAddress, data: plan.creationData, value: 0n, gasLimit, operation: `Deploy ${plan.kind}`, checkedAt: prepared.checkedAt }, plan };
  if (!ctx.flags.send) return preview;
  await consent(ctx, preview);
  claimOperation(ctx, id, 'creation', plan.id);
  const wallet = await ctx.signer();
  if (wallet.address.toLowerCase() !== plan.from.toLowerCase()) throw new CliError('SIGNER_MISMATCH', 'Wallet differs from the deployment sender.', {}, 3);
  const accountKey = sdk.recoveryAccountKey(ctx.chainId, plan.from), cursor = await ctx.store.read(accountKey), nonce = plan.quaiCreation.nonce;
  if (cursor && (cursor.kind !== 'nonce' || cursor.blockedBy || cursor.nextNonce > nonce)) throw new CliError('RECOVERY_BLOCKED', 'Account has pending or unresolved nonce state. Inspect tx list.', { id: cursor.kind === 'nonce' ? cursor.blockedBy : undefined }, 4);
  let record: CreationRecord = detached({ version: 1, id, revision: 0, kind: 'creation', plan, status: 'prepared' });
  if (!ctx.store.insert(key, record)) throw new CliError('RECOVERY_CONFLICT', 'Deployment ID was claimed concurrently.', { id }, 3);
  let attempted = false;
  try {
    if (!await ctx.store.compareAndSwap(accountKey, cursor?.revision ?? null, { version: 1, kind: 'nonce', id: accountKey, revision: cursor ? cursor.revision + 1 : 0, chainId: ctx.chainId, from: plan.from, nextNonce: nonce + 1, blockedBy: id })) throw new CliError('RECOVERY_CONFLICT', 'Account was reserved concurrently.', { id }, 3);
    await sdk.prepareDeploymentWorkflowStep(plan, 'create', ctx.provider, options(ctx));
    const request = await ctx.rpc(() => wallet.populateQuaiTransaction({ chainId: BigInt(ctx.chainId), from: plan.from, data: plan.creationData, nonce, gasLimit, value: 0n }));
    const signed = await ctx.rpc(() => wallet.signTransaction({ ...request, from: plan.from }));
    const decoded = QuaiTransaction.from(signed), hash = decoded.hash;
    if (!hash || decoded.chainId !== BigInt(ctx.chainId) || decoded.from?.toLowerCase() !== plan.from.toLowerCase() || decoded.to != null || decoded.nonce !== nonce || decoded.data !== plan.creationData || decoded.value !== 0n || decoded.gasLimit !== gasLimit) throw new CliError('PLAN_CHANGED', 'Signed deployment differs from the reviewed request.', {}, 3);
    await ctx.assertNetwork(); ctx.signal.throwIfAborted();
    // Persist the locally computed hash before the only broadcast call. No signed bytes are stored.
    record = updateCreation(ctx, record, { status: 'broadcasting', hash });
    attempted = true;
    const response = await ctx.rpc(() => ctx.provider.broadcastTransaction(Zone.Cyprus1, signed));
    if (response.hash !== hash) throw new CliError('TX_PENDING', 'RPC returned a different hash. Reconcile the stored signed hash.', { id, hash }, 4);
    record = updateCreation(ctx, record, { status: 'submitted' });
    process.stderr.write(json({ event: 'submitted', id, hash }) + '\n');
    await sdk.resumeTransaction(ctx.provider, hash, options(ctx));
    const result = await recoverCreation(ctx, id) as { outcome: string };
    if (result.outcome !== 'mined') throw new CliError('TX_PENDING', 'Deployment needs further confirmation.', { id, hash }, 4);
    return { mode: 'mined', changed: true, id, hash, ...result };
  } catch (error) {
    if (!attempted) {
      const current = ctx.store.get<CreationRecord>(key)!;
      if (current.status === 'prepared') record = updateCreation(ctx, current, { status: 'not_sent' });
      await releaseCreation(ctx, record, false);
      throw error;
    }
    throw new CliError('TX_PENDING', 'Deployment broadcast began. Reconcile its recorded hash before taking further action.', { id, hash: record.hash }, 4);
  }
}
