import { Interface, ZeroAddress, type EventFragment, type FunctionFragment } from 'quais';
import * as sdk from '@daoships/sdk';
import type { ContractName, IndexerTable } from '@daoships/sdk';
import { Context, NETWORKS, checkedAddress, networkName } from './context.js';
import { type Action, transact } from './actions.js';
import { CliError, abiArgs, abiValue, amount, errorInfo, fail, integer, json, readJsonInput, title } from './values.js';
import { creationKey, deployNavigator, executeLaunch, launchPlan, navigatorKind, navigatorPlan, readPlan, recoverCreation, type CreationRecord } from './deployments.js';
import { createWallet, importWallet, migrateWallet, importKeystore, exportKeystore, changePassword, verifyWallet, removeWallet } from './wallets.js';
import { assertBusinessOutcome } from './outcomes.js';

export type Input = Record<string, unknown>;
export interface Field { name: string; label: string; type?: 'text' | 'address' | 'json' | 'number' | 'choice'; optional?: boolean; choices?: readonly string[]; hint?: string; default?: string; context?: 'dao' | 'from' }
export interface CommandSpec { path: string; description: string; fields: Field[]; category: string; secret?: boolean; effect: 'read' | 'write' | 'local'; run(ctx: Context, input: Input): unknown | Promise<unknown> }
const commands: CommandSpec[] = [];
const add = (path: string, description: string, fields: Field[], effect: CommandSpec['effect'], run: CommandSpec['run']) => commands.push({ path, description, fields, effect, category: title(path.split(' ')[0]!), run });
const field = (name: string, label: string, type: Field['type'] = 'text', optional = false, hint?: string): Field => ({ name, label, type, optional, hint });
const dao: Field = { name: 'dao', label: 'DAO address or alias', type: 'address', optional: true, context: 'dao' };
const account: Field = { name: 'account', label: 'Member address', type: 'address', optional: true, context: 'from' };
const proposal = field('proposal', 'Proposal ID', 'number');
const payload = field('data', 'JSON or @file.json', 'json');
const text = (p: Input, key: string, fallback = ''): string => p[key] === undefined ? fallback : String(p[key]);
const id = (p: Input) => integer(p.proposal, 'proposal', 0xffffffff);
const action = (prepare: Action['prepare'], finish?: Action['finish']): Action => ({ prepare, finish });
export function contractKind(value: unknown): ContractName {
  if (typeof value !== 'string' || !Object.hasOwn(sdk.CONTRACT_ABIS, value)) return fail('Select a known contract kind; run contract kinds.');
  return value as ContractName;
}
export function contractMethods(kind: ContractName) {
  return new Interface(sdk.CONTRACT_ABIS[kind]).fragments.filter((f): f is FunctionFragment => f.type === 'function').map(f => ({ name: f.name, signature: f.format('sighash'),
    effect: ['view', 'pure'].includes(f.stateMutability) ? 'read' : 'write', payable: f.payable,
    inputs: f.inputs.map(p => ({ name: p.name, type: p.format('full'), abiType: p.format('sighash') })), outputs: f.outputs.map(p => ({ name: p.name, type: p.format('full') })) }));
}
export function contractEvents(kind: ContractName) {
  return new Interface(sdk.CONTRACT_ABIS[kind]).fragments.filter((f): f is EventFragment => f.type === 'event');
}
export function receiptEvents(kind: ContractName, emitter: string, receipt: sdk.Receipt, name?: string) {
  return contractEvents(kind).filter(f => !name || f.name === name || f.format('sighash') === name).flatMap(f =>
    sdk.parseContractEvents(receipt, kind, emitter, f.format('sighash') as never).map(event => ({ name: event.name, signature: event.signature,
      args: Object.fromEntries(f.inputs.map((p, i) => [p.name || `arg${i}`, (event.args as readonly unknown[])[i]])) })));
}
function client(ctx: Context, p: Input, withProvider = false) { return new sdk.ContractClient(contractKind(p.kind), ctx.resolve(text(p, 'address')), withProvider ? ctx.provider : undefined); }
function encoded(ctx: Context, p: Input) {
  const c = client(ctx, p), fragment = c.interface.getFunction(text(p, 'method'));
  if (!fragment || ['view', 'pure'].includes(fragment.stateMutability)) return fail('Select a write method from contract methods.');
  const args = abiArgs(fragment.inputs, p.args ?? []);
  if (sdk.NAVIGATOR_KINDS.includes(p.kind as sdk.NavigatorKind)) return new sdk.Navigator(p.kind as sdk.NavigatorKind, c.address).encode(fragment.format('sighash') as never, args as never, amount(p.value ?? '0'));
  return c.encode(fragment.format('sighash') as never, args as never, { value: amount(p.value ?? '0') });
}
const kind: Field = { name: 'kind', label: 'Contract', type: 'choice', choices: Object.keys(sdk.CONTRACT_ABIS) };
const target = field('address', 'Contract address', 'address');
const method = field('method', 'Method or full signature');
const args: Field = { name: 'args', label: 'Arguments', type: 'json', optional: true, default: '[]', hint: 'JSON array. Use decimal strings for integers. Overloads require a full signature.' };
const value: Field = { name: 'value', label: 'Native value (wei)', type: 'number', optional: true, default: '0' };

add('status', 'Connection, identity, selected DAO and indexer health', [], 'read', async ctx => {
  const results = await Promise.allSettled([ctx.head(), ctx.indexer.getStateDetails(ctx.signal)]);
  return { network: ctx.network, chainId: ctx.chainId, dao: ctx.flags.dao ? ctx.resolve(ctx.flags.dao) : ctx.config.daos[ctx.network] ?? null, address: ctx.flags.from || ctx.flags.wallet || ctx.config.wallet || ctx.config.address ? ctx.from() : null,
    head: results[0].status === 'fulfilled' ? results[0].value : null,
    indexer: results[1].status === 'fulfilled' ? results[1].value : null,
    degraded: results.some(r => r.status === 'rejected'), errors: results.flatMap((r, i) => r.status === 'rejected' ? [{ source: i === 0 ? 'rpc' : 'indexer', ...errorInfo(r.reason) }] : []), configDirectory: ctx.store.directory };
});
add('doctor', 'Check chain identity and indexer freshness', [], 'read', async ctx => {
  const head = await ctx.head(), checkpoint = await ctx.indexer.getStateDetails(ctx.signal);
  return { head, checkpoint, health: sdk.assertIndexerHealthy(checkpoint, { chainId: ctx.chainId, nowMs: Date.now(), maxAgeMs: 300_000, ...(head.number === undefined ? {} : { expectedBlock: BigInt(head.number), maxBlockLag: 25n }) }) };
});
add('network list', 'Available Quai networks', [], 'local', ctx => ({ active: ctx.network, networks: NETWORKS }));
add('network use', 'Set the default network', [{ name: 'network', label: 'Network', type: 'choice', choices: ['orchard', 'mainnet'] }], 'local', (ctx, p) => { ctx.config.network = networkName(text(p, 'network')); ctx.save(); return { network: ctx.config.network }; });
add('config show', 'Show public configuration', [], 'local', ctx => ({ directory: ctx.store.directory, ...ctx.config }));
add('alias set', 'Name a DAO, contract or account', [field('name', 'Alias'), target], 'local', (ctx, p) => {
  const name = text(p, 'name'); if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/.test(name) || ['constructor', 'prototype', '__proto__'].includes(name)) return fail('Use a short alphanumeric alias.');
  ctx.config.aliases[name] = checkedAddress(text(p, 'address')); ctx.save(); return { name, address: ctx.config.aliases[name] };
});
add('alias list', 'List named addresses', [], 'local', ctx => ctx.config.aliases);
add('alias remove', 'Remove an address alias', [field('name', 'Alias')], 'local', (ctx, p) => { delete ctx.config.aliases[text(p, 'name')]; ctx.save(); return ctx.config.aliases; });
add('wallet watch', 'Use a public address without importing a key', [target], 'local', (ctx, p) => { ctx.config.address = ctx.resolve(text(p, 'address')); delete ctx.config.wallet; ctx.save(); return { address: ctx.config.address }; });
const walletField = field('name', 'Wallet name');
add('wallet create', 'Create and encrypt a new Cyprus-1 account', [walletField], 'local', (ctx, p) => createWallet(ctx, text(p, 'name')));
add('wallet import', 'Encrypt a private key from a hidden prompt, key file or named environment variable', [walletField, field('env', 'Environment variable (optional)', 'text', true, 'Leave blank for hidden key entry, or pass --key-file.')], 'local', (ctx, p) => importWallet(ctx, text(p, 'name'), text(p, 'env') || undefined));
add('wallet migrate', 'Convert a legacy environment wallet into an encrypted keystore', [walletField], 'local', (ctx, p) => migrateWallet(ctx, text(p, 'name')));
add('wallet import-keystore', 'Restore a V3 keystore with a fresh password and encryption', [walletField, field('file', 'Encrypted keystore file')], 'local', (ctx, p) => importKeystore(ctx, text(p, 'name'), text(p, 'file')));
add('wallet export', 'Export an encrypted V3 backup to a new file', [walletField, field('file', 'New backup file')], 'local', (ctx, p) => exportKeystore(ctx, text(p, 'name'), text(p, 'file')));
add('wallet verify', 'Unlock locally and verify the account identity', [walletField], 'local', (ctx, p) => verifyWallet(ctx, text(p, 'name')));
add('wallet change-password', 'Re-encrypt a wallet with a fresh password', [walletField], 'local', (ctx, p) => changePassword(ctx, text(p, 'name')));
add('wallet list', 'List public wallet profiles', [], 'local', ctx => ({ active: ctx.config.wallet, address: ctx.config.address, wallets: ctx.config.wallets }));
add('wallet use', 'Select an encrypted wallet', [walletField], 'local', (ctx, p) => {
  const name = text(p, 'name'); if (!Object.hasOwn(ctx.config.wallets, name)) return fail('Unknown wallet. Run wallet list or wallet import.');
  ctx.config.wallet = name; ctx.config.address = ctx.config.wallets[name]!.address; ctx.save(); return { name, ...ctx.config.wallets[name] };
});
add('wallet remove', 'Delete a local wallet and its encrypted keystore after confirmation', [walletField], 'local', (ctx, p) => removeWallet(ctx, text(p, 'name')));
for (const command of commands) if (['wallet create', 'wallet import', 'wallet migrate', 'wallet import-keystore', 'wallet verify', 'wallet change-password', 'wallet remove'].includes(command.path)) command.secret = true;

add('dao list', 'Discover indexed DAOs', [], 'read', ctx => ctx.indexer.list('daos', ctx.page()));
add('dao use', 'Select a DAO for subsequent commands', [{ ...dao, optional: false }], 'local', (ctx, p) => { ctx.config.daos[ctx.network] = ctx.resolve(text(p, 'dao')); ctx.save(); return { network: ctx.network, dao: ctx.config.daos[ctx.network] }; });
add('dao show', 'Read DAO configuration from chain', [dao], 'read', (ctx, p) => ctx.chain.getDao(ctx.dao(text(p, 'dao'))));
add('dao profile', 'Read joined DAO metadata and provenance', [dao], 'read', (ctx, p) => ctx.data.getDaoProfile(ctx.dao(text(p, 'dao')), { signal: ctx.signal, chainId: ctx.chainId }));
add('dao treasury', 'Read registered treasury assets from chain', [dao], 'read', (ctx, p) => ctx.chain.getTreasury(ctx.dao(text(p, 'dao'))));
add('dao members', 'List indexed DAO members', [dao], 'read', (ctx, p) => ctx.indexer.listMembers(ctx.dao(text(p, 'dao')), ctx.page()));
add('dao member', 'Read member balances and voting power', [account, dao], 'read', (ctx, p) => ctx.chain.getMember(ctx.dao(text(p, 'dao')), text(p, 'account') ? ctx.resolve(text(p, 'account')) : ctx.from()));
add('dao capabilities', 'Read the account’s current DAO permissions', [account, dao], 'read', (ctx, p) => ctx.chain.getCapabilities(ctx.dao(text(p, 'dao')), text(p, 'account') ? ctx.resolve(text(p, 'account')) : ctx.from()));
add('dao governance', 'Prepare a DAO self-call as a governance proposal', [payload, dao], 'write', (ctx, p) => {
  const call = governance(p.data), data = sdk.encodeProposal([sdk.buildGovernanceAction(ctx.dao(text(p, 'dao')), call)]);
  return action(() => ctx.chain.prepareSubmit(ctx.dao(text(p, 'dao')), ctx.from(), data, 'DAO governance update'), receipt => ({ proposalId: sdk.parseSubmitReceipt(receipt, ctx.dao(text(p, 'dao'))) }));
});
add('dao ragequit', 'Withdraw treasury assets by burning shares and loot', [field('shares', 'Shares to burn', 'number'), field('loot', 'Loot to burn', 'number'), field('tokens', 'Token address array', 'json'), dao], 'write', (ctx, p) =>
  action(() => ctx.chain.prepareRagequit(ctx.dao(text(p, 'dao')), ctx.from(), ctx.from(), amount(p.shares), amount(p.loot), addresses(ctx, p.tokens))));

add('proposal list', 'List DAO proposals', [dao], 'read', (ctx, p) => ctx.indexer.listProposals(ctx.dao(text(p, 'dao')), ctx.page()));
add('proposal show', 'Inspect proposal state, calldata and commitment', [proposal, dao], 'read', async (ctx, p) => {
  const address = ctx.dao(text(p, 'dao')); const state = await ctx.chain.getProposal(address, id(p));
  const contract = new sdk.ContractClient('DAOShip', address, ctx.provider);
  const raw = await contract.read('proposals', [BigInt(id(p))], { blockTag: state.blockNumber, timeoutMs: ctx.timeout, signal: ctx.signal });
  const indexed = await ctx.indexer.getProposalDetails(address, id(p), ctx.signal).catch(() => null);
  let actions: unknown = null;
  if (indexed?.proposal_data) { sdk.verifyProposalDataHash(indexed.proposal_data, raw[10]); actions = sdk.decodeProposal(indexed.proposal_data); }
  return { ...state, stateName: sdk.ProposalState[state.state], contract: raw, indexed, actions };
});
add('proposal submit', 'Submit CALL-only actions for DAO governance', [field('actions', 'Proposal actions', 'json'), { name: 'details', label: 'Description', optional: true, default: 'DAOShips proposal' }, dao], 'write', (ctx, p) => {
  const data = proposalData(ctx, p.actions); return action(() => ctx.chain.prepareSubmit(ctx.dao(text(p, 'dao')), ctx.from(), data, text(p, 'details', 'DAOShips proposal')), receipt => ({ proposalId: sdk.parseSubmitReceipt(receipt, ctx.dao(text(p, 'dao'))) }));
});
add('proposal vote', 'Vote for or against a sponsored proposal', [proposal, { name: 'vote', label: 'Your vote', type: 'choice', choices: ['yes', 'no'] }, dao], 'write', (ctx, p) => action(() => ctx.chain.prepareVote(ctx.dao(text(p, 'dao')), id(p), text(p, 'vote') === 'yes', ctx.from())));
for (const verb of ['sponsor', 'cancel'] as const) add(`proposal ${verb}`, `${title(verb)} a proposal`, [proposal, dao], 'write', (ctx, p) => action(() => verb === 'sponsor' ? ctx.chain.prepareSponsor(ctx.dao(text(p, 'dao')), id(p), ctx.from()) : ctx.chain.prepareCancel(ctx.dao(text(p, 'dao')), id(p), ctx.from())));
add('proposal process', 'Execute the committed actions and verify their outcome', [proposal, { name: 'actions', label: 'Actions or committed calldata', type: 'json', optional: true, hint: 'Leave empty to fetch indexed calldata and verify it against the chain.' }, dao], 'write', async (ctx, p) => {
  const address = ctx.dao(text(p, 'dao'));
  const data = p.actions === undefined ? (await ctx.indexer.getProposalDetails(address, id(p), ctx.signal))?.proposal_data : proposalData(ctx, p.actions);
  if (!data) return fail('Provide the proposal actions or a JSON string containing committed calldata.');
  return action(() => ctx.chain.prepareProcess(address, id(p), ctx.from(), data), receipt => { sdk.assertActionSucceeded(receipt, address, id(p)); return { proposalId: id(p), executed: true }; });
});

add('contract kinds', 'List every SDK contract interface', [], 'local', () => Object.keys(sdk.CONTRACT_ABIS));
add('contract methods', 'Discover typed reads, writes and overloads', [kind], 'local', (_ctx, p) => contractMethods(contractKind(p.kind)));
add('contract events', 'Discover event signatures and named fields', [kind], 'local', (_ctx, p) => contractEvents(contractKind(p.kind)).map(f => ({ name: f.name, signature: f.format('sighash'), inputs: f.inputs.map(p => ({ name: p.name, type: p.format('sighash'), indexed: p.indexed })) })));
add('contract read', 'Read any of the SDK’s contract methods', [kind, target, method, args], 'read', (ctx, p) => {
  const c = client(ctx, p, true), fragment = c.interface.getFunction(text(p, 'method'));
  if (!fragment) return fail('Unknown method.');
  return c.read(fragment.format('sighash') as never, abiArgs(fragment.inputs, p.args ?? []) as never, { timeoutMs: ctx.timeout, signal: ctx.signal });
});
add('contract encode', 'Encode any contract write without RPC or signing', [kind, target, method, args, value], 'local', encoded);
add('contract write', 'Simulate and optionally send any SDK contract write', [kind, target, method, args, value], 'write', (ctx, p) => {
  const call = encoded(ctx, p);
  return action(() => ctx.chain.prepareCall(call, ctx.from()), receipt => {
    if (p.kind === 'DAOShip' && call.operation.startsWith('processProposal')) sdk.assertActionSucceeded(receipt, call.to, integer((p.args as unknown[])[0], 'proposal', 0xffffffff));
    return { operation: call.operation, events: receiptEvents(contractKind(p.kind), call.to, receipt), logs: receipt.logs };
  });
});
add('navigator list', 'List this DAO’s navigators and trust state', [dao], 'read', (ctx, p) => ctx.indexer.listNavigators(ctx.dao(text(p, 'dao')), ctx.page()));
const navKind: Field = { ...kind, choices: sdk.NAVIGATOR_KINDS };
const navConfig: Field = { name: 'config', label: 'Constructor configuration', type: 'json', hint: 'Named constructor fields. navigator constructors lists every field.' };
const navOptions: Field = { name: 'options', label: 'Endorsement and funding options', type: 'json', optional: true, default: '{}', hint: 'Signal requires signalEndorsement: {poster,currentNavigators:[...]}; funding is optional.' };
const planField = field('plan', 'Saved plan JSON or @file', 'json');
add('navigator constructors', 'Discover the constructor schema for a navigator', [navKind], 'local', (_ctx, p) => new Interface(sdk.CONTRACT_ABIS[navigatorKind(p.kind)]).deploy.inputs.map(f => ({ name: f.name.replace(/^_/, ''), type: f.format('sighash') })));
add('navigator plan', 'Grind a Cyprus-1 address and plan deployment and activation', [navKind, navConfig, navOptions], 'read', (ctx, p) => navigatorPlan(ctx, navigatorKind(p.kind), p.config, p.options));
add('navigator deploy', 'Prepare or deploy a navigator with bundled SDK bytecode', [navKind, navConfig, navOptions], 'write', async (ctx, p) => {
  if (ctx.flags.send && ctx.flags.id && ctx.store.get(creationKey(ctx.flags.id))) throw new CliError('RECOVERY_CONFLICT', 'This deployment is already recorded. Use tx recover, or navigator execute with its saved plan.', { id: ctx.flags.id }, 4);
  return deployNavigator(ctx, await navigatorPlan(ctx, navigatorKind(p.kind), p.config, p.options));
});
add('navigator execute', 'Preview or execute a saved navigator creation plan', [planField], 'write', (ctx, p) => { const plan = readPlan(p.plan); if (plan.type !== 'navigator') return fail('Expected a navigator plan.'); return deployNavigator(ctx, plan); });
add('launch discover', 'Verify and discover a launcher’s deployment contracts', [field('launcher', 'Combined launcher', 'address')], 'read', (ctx, p) => sdk.discoverDeployment(ctx.provider, { launcher: ctx.resolve(text(p, 'launcher')), chainId: ctx.chainId, timeoutMs: ctx.timeout, signal: ctx.signal }));
add('launch plan', 'Discover factories and mine a complete DAO launch plan', [field('config', 'Launch configuration', 'json')], 'read', (ctx, p) => launchPlan(ctx, p.config));
add('launch execute', 'Simulate or launch a DAO and verify its postconditions', [planField], 'write', (ctx, p) => executeLaunch(ctx, p.plan));
add('workflow prepare', 'Refresh prerequisites and show an exact workflow step', [planField, field('step', 'Step ID')], 'read', (ctx, p) => {
  const plan = readPlan(p.plan); if (plan.chainId !== ctx.chainId) throw new CliError('CHAIN_MISMATCH', 'Plan belongs to another network.', {}, 3);
  return sdk.prepareDeploymentWorkflowStep(plan, text(p, 'step'), ctx.provider, { timeoutMs: ctx.timeout, signal: ctx.signal });
});
add('workflow verify', 'Verify a mined deployment, activation or vault setup step', [planField, field('step', 'Step ID'), field('hash', 'Transaction hash')], 'read', async (ctx, p) => {
  const plan = readPlan(p.plan); if (plan.chainId !== ctx.chainId) throw new CliError('CHAIN_MISMATCH', 'Plan belongs to another network.', {}, 3);
  const receipt = await ctx.rpc(() => ctx.provider.getTransactionReceipt(text(p, 'hash')));
  if (!receipt) throw new CliError('TX_PENDING', 'No receipt is available for this step.', { hash: p.hash }, 4);
  await sdk.verifyDeploymentWorkflowStep(plan, text(p, 'step'), receipt, ctx.provider, { timeoutMs: ctx.timeout, signal: ctx.signal, confirmations: ctx.confirmations });
  return { verified: true, planId: plan.id, step: p.step, hash: receipt.hash, blockNumber: receipt.blockNumber };
});
add('workflow execute', 'Execute a direct transaction step and verify its postconditions', [planField, field('step', 'Step ID')], 'write', (ctx, p) => {
  const plan = readPlan(p.plan), step = plan.steps.find(s => s.id === p.step);
  if (step?.kind !== 'transaction') return fail('Use navigator execute for CREATE, workflow propose for governance, or authorized vault execution for this step.');
  if (plan.chainId !== ctx.chainId || plan.from.toLowerCase() !== ctx.from().toLowerCase()) throw new CliError('PLAN_CHANGED', 'Network or sender differs from the plan.', {}, 3);
  return action(async () => {
    const prepared = await sdk.prepareDeploymentWorkflowStep(plan, step.id, ctx.provider, { timeoutMs: ctx.timeout, signal: ctx.signal });
    if (!prepared.transaction) return fail('This step did not prepare a direct transaction.'); return prepared.transaction;
  }, async receipt => { await sdk.verifyDeploymentWorkflowStep(plan, step.id, receipt as sdk.DeploymentExecutionReceipt, ctx.provider, { timeoutMs: ctx.timeout, signal: ctx.signal, confirmations: ctx.confirmations }); return { planId: plan.id, step: step.id, verified: true }; });
});
add('workflow propose', 'Submit navigator activation actions to DAO governance', [planField, field('step', 'Step ID')], 'write', async (ctx, p) => {
  const plan = readPlan(p.plan), step = plan.steps.find(s => s.id === p.step);
  if (plan.type !== 'navigator' || step?.kind !== 'dao-governance' || !step.proposalData) return fail('This step is not a DAO governance proposal.');
  if (plan.chainId !== ctx.chainId) throw new CliError('CHAIN_MISMATCH', 'Plan belongs to another network.', {}, 3);
  await sdk.prepareDeploymentWorkflowStep(plan, step.id, ctx.provider, { timeoutMs: ctx.timeout, signal: ctx.signal });
  return action(() => ctx.chain.prepareSubmit(plan.daoShip, ctx.from(), step.proposalData!, `Activate ${plan.kind}`), receipt => ({ proposalId: sdk.parseSubmitReceipt(receipt, plan.daoShip), next: 'Sponsor, vote and process; then workflow verify the activation using its process receipt.' }));
});
add('navigator show', 'Inspect navigator identity, requirements and indexed state', [target, dao], 'read', async (ctx, p) => {
  const address = ctx.resolve(text(p, 'address')), common = new sdk.ContractClient('VestingNavigator', address, ctx.provider);
  const [name, parent] = await Promise.all([common.read('navigatorType', [], { timeoutMs: ctx.timeout, signal: ctx.signal }), common.read('daoShip', [], { timeoutMs: ctx.timeout, signal: ctx.signal })]);
  const navKind = contractKind(name);
  if (!sdk.NAVIGATOR_KINDS.includes(navKind as sdk.NavigatorKind)) return fail('Unsupported navigator type.');
  return { address, kind: navKind, dao: parent, requirements: sdk.getNavigatorRequirements(navKind as sdk.NavigatorKind), methods: contractMethods(navKind), indexed: await ctx.indexer.getNavigator(parent, address, ctx.signal) };
});
for (const verb of ['methods', 'read', 'write'] as const) {
  const original = commands.find(c => c.path === `contract ${verb}`)!;
  add(`navigator ${verb}`, `Navigator ${verb} across every supported signature`, original.fields.map(f => f.name === 'kind' ? { ...f, choices: sdk.NAVIGATOR_KINDS } : f), original.effect, original.run);
}

add('token info', 'Read token name, symbol, precision and supply', [target], 'read', async (ctx, p) => {
  const c = new sdk.ContractClient('SharesERC20', ctx.resolve(text(p, 'address')), ctx.provider);
  const options = { timeoutMs: ctx.timeout, signal: ctx.signal };
  const [name, symbol, decimals, totalSupply] = await Promise.all([c.read('name', [], options), c.read('symbol', [], options), c.read('decimals', [], options), c.read('totalSupply', [], options)]);
  return { address: c.address, name, symbol, decimals, totalSupply };
});
add('token balance', 'Read a token balance in exact base units', [target, account], 'read', (ctx, p) => new sdk.ContractClient('SharesERC20', ctx.resolve(text(p, 'address')), ctx.provider).read('balanceOf', [text(p, 'account') ? ctx.resolve(text(p, 'account')) : ctx.from()], { timeoutMs: ctx.timeout, signal: ctx.signal }));
for (const verb of ['transfer', 'approve', 'delegate'] as const) add(`token ${verb}`, `${title(verb)} tokens or voting power`, [target, field('to', verb === 'approve' ? 'Spender' : verb === 'delegate' ? 'Delegate' : 'Recipient', 'address'), ...(verb === 'delegate' ? [] : [field('amount', 'Amount (base units)', 'number')])], 'write', (ctx, p) => {
  const to = ctx.resolve(text(p, 'to')), token = new sdk.ContractClient('SharesERC20', ctx.resolve(text(p, 'address')));
  const call = verb === 'delegate' ? token.encode('delegate', [to]) : token.encode(verb, [to, amount(p.amount)]);
  return action(() => ctx.chain.prepareCall(call, ctx.from()), receipt => {
    if (verb !== 'delegate') {
      const matches = verb === 'transfer' ? sdk.parseContractEvents(receipt, 'SharesERC20', token.address, 'Transfer').some(e => e.args.from === ctx.from() && e.args.to === to && e.args.value === amount(p.amount))
        : sdk.parseContractEvents(receipt, 'SharesERC20', token.address, 'Approval').some(e => e.args.owner === ctx.from() && e.args.spender === to && e.args.value === amount(p.amount));
      if (!matches) throw new CliError('MISSING_EVENT', 'The receipt does not confirm the requested token change.', {}, 3);
    }
    return { token: token.address, to, amount: p.amount };
  });
});
add('balance', 'Read a native QUAI balance', [account], 'read', async (ctx, p) => { await ctx.assertNetwork(); const address = text(p, 'account') ? ctx.resolve(text(p, 'account')) : ctx.from(); return { address, wei: await ctx.rpc(() => ctx.provider.getBalance(address)) }; });
add('transfer', 'Preview or transfer native QUAI in exact wei', [field('to', 'Recipient', 'address'), field('amount', 'Amount (wei)', 'number')], 'write', (ctx, p) => action(() => ctx.chain.prepareCall({ to: ctx.resolve(text(p, 'to')), data: '0x', value: amount(p.amount), operation: 'transferQuai' }, ctx.from())));

const table: Field = { name: 'table', label: 'Indexer table', type: 'choice', choices: Object.keys(sdk.indexerShapes) };
add('indexer tables', 'Discover every indexed table and its fields', [], 'local', () => sdk.indexerShapes);
add('indexer state', 'Read the current indexing checkpoint', [], 'read', ctx => ctx.indexer.getStateDetails(ctx.signal));
for (const verb of ['list', 'count'] as const) add(`indexer ${verb}`, `${title(verb)} indexed rows with typed filters`, [table, { name: 'query', label: 'Query options', type: 'json', optional: true, default: '{}' }], 'read', (ctx, p) => {
  const name = text(p, 'table') as IndexerTable; if (!Object.hasOwn(sdk.indexerShapes, name)) return fail('Unknown indexer table.');
  return verb === 'list' ? ctx.indexer.list(name, { ...ctx.page(), ...p.query as object, signal: ctx.signal }) : ctx.indexer.count(name, { ...p.query as object, signal: ctx.signal });
});
add('indexer get', 'Fetch a row by its exact indexed ID', [table, field('id', 'Row ID')], 'read', (ctx, p) => ctx.indexer.get(text(p, 'table') as IndexerTable, text(p, 'id'), ctx.signal));
add('activity list', 'Browse this DAO’s indexed transaction history', [dao], 'read', (ctx, p) => ctx.indexer.list('event_transactions', { ...ctx.page(), filters: { dao_id: ctx.dao(text(p, 'dao')).toLowerCase() }, orderBy: 'block_number', direction: 'desc' }));

add('tx list', 'Browse the local durable transaction journal', [], 'local', ctx => {
  const page = ctx.page(), records = ctx.store.records(page.limit, page.offset), creations = ctx.store.documents<CreationRecord>('creation:', page.limit, page.offset);
  return { items: records.filter(r => r.kind === 'transaction' && r.intent.chainId === ctx.chainId), creations: creations.filter(r => r.plan.chainId === ctx.chainId), nextOffset: records.length || creations.length ? page.offset + page.limit : null };
});
add('tx show', 'Inspect durable intent by operation ID', [field('id', 'Operation ID')], 'local', async (ctx, p) => ctx.store.get(creationKey(text(p, 'id'))) ?? await ctx.store.read(sdk.recoveryTransactionKey(text(p, 'id'))));
add('tx recover', 'Reconcile a recorded send without broadcasting', [field('id', 'Operation ID'), field('hash', 'Independent original transaction hash', 'text', true), field('replacement', 'Replacement transaction hash', 'text', true)], 'read', async (ctx, p) => {
  const id = text(p, 'id');
  const creation = ctx.store.get(creationKey(id));
  if (creation && (p.hash || p.replacement)) return fail('Native CREATE recovery uses its locally stored signed hash. Hash overrides apply to ordinary sends.');
  const result = creation ? await recoverCreation(ctx, id) as { outcome: string; record: CreationRecord } : await sdk.inspectRecoveryTransaction(ctx.store, ctx.provider, id, { timeoutMs: ctx.timeout, confirmations: ctx.confirmations, ...(p.hash ? { transactionHash: text(p, 'hash') } : {}), ...(p.replacement ? { replacementHash: text(p, 'replacement') } : {}) });
  if (result.outcome === 'reverted') throw new CliError('TX_REVERTED', 'The recorded transaction reverted.', { id, hash: result.record.hash, outcome: result.outcome }, 3);
  if (!['mined', 'not_sent', 'cancelled', 'replaced'].includes(result.outcome)) throw new CliError('TX_PENDING', 'The transaction still needs reconciliation. No transaction was broadcast.', { id, hash: result.record.hash, outcome: result.outcome }, 4);
  if (result.outcome === 'mined' && result.record.kind === 'transaction') {
    const receipt = await ctx.rpc(() => ctx.provider.getTransactionReceipt(result.record.hash!));
    if (!receipt) throw new CliError('TX_PENDING', 'The verified receipt is temporarily unavailable.', { id, hash: result.record.hash }, 4);
    try { assertBusinessOutcome(result.record.intent, receipt); }
    catch (error) { const info = errorInfo(error); throw new CliError(info.code, info.message, { ...info.details, id, hash: result.record.hash }, info.exitCode); }
  }
  return result;
});
add('tx replacements', 'Find replacement candidates in a bounded canonical block window', [field('id', 'Operation ID'), field('fromBlock', 'First block', 'number'), field('toBlock', 'Last block', 'number')], 'read', async (ctx, p) => {
  const record = await ctx.store.read(sdk.recoveryTransactionKey(text(p, 'id')));
  if (!record || record.kind !== 'transaction') return fail('Choose an ordinary transaction from tx list.');
  if (record.intent.chainId !== ctx.chainId) throw new CliError('CHAIN_MISMATCH', 'Transaction belongs to another network.', {}, 3);
  return ctx.rpc(() => sdk.scanRecoveryReplacements(ctx.provider, record.intent, { fromBlock: integer(p.fromBlock, 'fromBlock'), toBlock: integer(p.toBlock, 'toBlock'), maxBlocks: 128, maxTransactions: 1000, originalHash: record.hash, timeoutMs: ctx.timeout }));
});
add('tx wait', 'Wait for a hash and verify its receipt status', [field('hash', 'Transaction hash')], 'read', (ctx, p) => sdk.resumeTransaction(ctx.provider, text(p, 'hash'), { timeoutMs: ctx.timeout, confirmations: ctx.confirmations, signal: ctx.signal }));
add('tx events', 'Decode a receipt into named events from an exact emitter', [kind, target, field('hash', 'Transaction hash'), field('event', 'Event name or full signature', 'text', true)], 'read', async (ctx, p) => {
  await ctx.assertNetwork(); const receipt = await ctx.rpc(() => ctx.provider.getTransactionReceipt(text(p, 'hash')));
  if (!receipt) throw new CliError('TX_PENDING', 'Receipt is unavailable.', { hash: p.hash }, 4);
  const name = contractKind(p.kind);
  if (p.event && !contractEvents(name).some(f => f.name === p.event || f.format('sighash') === p.event)) return fail('Unknown event. Use contract events to discover signatures.');
  return { hash: receipt.hash, blockNumber: receipt.blockNumber, events: receiptEvents(name, ctx.resolve(text(p, 'address')), receipt, p.event ? String(p.event) : undefined) };
});
add('tx abandon', 'Abandon only a provably unsent prepared operation', [field('id', 'Operation ID')], 'local', (ctx, p) => ctx.store.get(creationKey(text(p, 'id'))) ? recoverCreation(ctx, text(p, 'id'), true) : sdk.abandonPreparedTransaction(ctx.store, text(p, 'id')));

add('proposal encode', 'Encode proposal actions and their commitment hash', [field('actions', 'CALL-only actions', 'json')], 'local', (ctx, p) => { const data = proposalData(ctx, p.actions); return { data, hash: sdk.hashProposalData(data), actions: sdk.decodeProposal(data) }; });
add('proposal decode', 'Decode bounded CALL-only proposal calldata', [field('data', 'Calldata')], 'local', (_ctx, p) => sdk.decodeProposal(text(p, 'data')));
add('governance encode', 'Encode a privileged DAO governance call', [payload, dao], 'local', (ctx, p) => sdk.buildGovernanceAction(ctx.dao(text(p, 'dao')), governance(p.data)));
add('poster publish', 'Prepare validated DAOShips metadata', [field('poster', 'Poster contract', 'address'), { name: 'tag', label: 'Metadata tag', type: 'choice', choices: Object.values(sdk.POSTER_TAGS) }, payload], 'write', (ctx, p) => {
  const call = sdk.encodePosterPost(ctx.resolve(text(p, 'poster')), text(p, 'tag') as sdk.PosterTag, p.data as never);
  return action(() => ctx.chain.prepareCall(call, ctx.from()));
});
add('allowlist build', 'Build an OpenZeppelin-compatible address Merkle tree', [field('addresses', 'Address array', 'json')], 'local', (ctx, p) => sdk.buildAllowlistTree(addresses(ctx, p.addresses)));
add('allowlist proof', 'Get a membership proof from a tree', [field('tree', 'Tree JSON or @file', 'json'), account], 'local', (ctx, p) => { sdk.validateAllowlistTree(p.tree); return sdk.getAllowlistProof(p.tree, text(p, 'account') ? ctx.resolve(text(p, 'account')) : ctx.from()); });
add('allowlist verify', 'Verify a membership proof independently', [field('root', 'Merkle root'), target, field('proof', 'Proof array', 'json')], 'local', (ctx, p) => ({ valid: sdk.verifyAllowlistProof(text(p, 'root'), ctx.resolve(text(p, 'address')), p.proof as string[]) }));
for (const verb of ['json', 'abi'] as const) add(`ipfs ${verb}`, `Read bounded IPFS ${verb.toUpperCase()}`, [field('resource', 'CID or ipfs:// URI')], 'read', (ctx, p) => (verb === 'json' ? sdk.fetchIpfsJson : sdk.fetchIpfsAbi)({ resource: text(p, 'resource'), timeoutMs: ctx.timeout, signal: ctx.signal }));
add('ipfs bytecode', 'Fetch bytecode with an independently trusted hash', [field('resource', 'CID or ipfs:// URI'), field('hash', 'Expected keccak256')], 'read', (ctx, p) => sdk.fetchIpfsBytecode({ resource: text(p, 'resource'), expectedKeccak256: text(p, 'hash'), timeoutMs: ctx.timeout, signal: ctx.signal }));

export function addresses(ctx: Context, input: unknown): string[] { if (!Array.isArray(input)) return fail('Expected an address array.'); return input.map(v => v === ZeroAddress ? v : ctx.resolve(String(v))); }
export function proposalData(ctx: Context, input: unknown): sdk.Hex {
  if (typeof input === 'string') { sdk.decodeProposal(input); return sdk.hex(input); }
  if (!Array.isArray(input) || !input.length) return fail('Expected a nonempty proposal action array.');
  return sdk.encodeProposal(input.map(v => ({ to: ctx.resolve(v.to), value: amount(v.value ?? '0'), data: sdk.hex(v.data), operation: integer(v.operation ?? 0, 'operation', 0) })));
}
function governance(input: unknown): sdk.GovernanceCall {
  if (!input || typeof input !== 'object') return fail('Expected a governance JSON object.');
  const p = { ...input } as Record<string, unknown>;
  for (const key of ['amount']) if (p[key] !== undefined) p[key] = amount(p[key]);
  for (const key of ['amounts', 'permissions']) if (Array.isArray(p[key])) p[key] = p[key].map(amount);
  if (p.config && typeof p.config === 'object') p.config = Object.fromEntries(Object.entries(p.config).map(([k, v]) => [k, ['votingPeriod', 'gracePeriod', 'defaultExpiryWindow'].includes(k) ? integer(v, k) : amount(v)]));
  return p as unknown as sdk.GovernanceCall;
}
export const COMMANDS = commands;
export async function execute(ctx: Context, spec: CommandSpec, raw: Input): Promise<unknown> {
  ctx.signal.throwIfAborted();
  const input: Input = {};
  for (const key of Object.keys(raw)) if (!spec.fields.some(f => f.name === key)) return fail(`Unknown input field: ${key}.`);
  for (const f of spec.fields) {
    let value = raw[f.name]; if (value === undefined || value === '') value = f.default;
    if (value === undefined) { if (!f.optional) return fail(`${f.label} is required.`); continue; }
    if (f.type === 'json' && typeof value === 'string') value = await readJsonInput(value);
    if (f.type !== 'json' && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') return fail(`${f.label} must be a string or exact number.`);
    if (f.choices && !f.choices.includes(String(value))) return fail(`${f.label}: choose ${f.choices.join(', ')}.`);
    input[f.name] = value;
  }
  const result = await spec.run(ctx, input);
  const outcome = result && typeof result === 'object' && 'prepare' in result && typeof result.prepare === 'function' ? await transact(ctx, result as Action) : result;
  return outcome && typeof outcome === 'object' && 'mode' in outcome && outcome.mode === 'preview' ? { request: { command: spec.path, inputs: input }, ...outcome } : outcome;
}
export function findCommand(path: string): CommandSpec { return COMMANDS.find(c => c.path === path) ?? fail(`Unknown command: ${path}. Use schema to discover commands.`); }
export function methodFields(kind: ContractName, signature: string): Field[] {
  const f = new Interface(sdk.CONTRACT_ABIS[kind]).getFunction(signature);
  if (!f) return fail('Unknown contract method.');
  return f.inputs.map((p, i) => ({ name: String(i), label: title(p.name || `Argument ${i + 1}`), type: p.type === 'bool' ? 'choice' : p.baseType === 'array' || p.baseType === 'tuple' ? 'json' : p.type === 'address' ? 'address' : 'text',
    ...(p.type === 'bool' ? { choices: ['true', 'false'] } : {}), hint: p.format('sighash') + (/int/.test(p.type) ? ' · exact base units' : '') }));
}
export function constructorFields(kind: sdk.NavigatorKind): Field[] {
  return new Interface(sdk.CONTRACT_ABIS[kind]).deploy.inputs.map(p => ({ name: p.name.replace(/^_/, ''), label: title(p.name.replace(/^_/, '')), type: p.type === 'bool' ? 'choice' : p.baseType === 'array' || p.baseType === 'tuple' ? 'json' : p.type === 'address' ? 'address' : 'text',
    ...(p.type === 'bool' ? { choices: ['false', 'true'] } : {}), ...(p.name.replace(/^_/, '') === 'daoShip' ? { context: 'dao' } : {}), hint: p.format('sighash') + (/int/.test(p.type) ? ' · exact base units' : '') }));
}
export function formArgs(kind: ContractName, signature: string, values: Input): string {
  const f = new Interface(sdk.CONTRACT_ABIS[kind]).getFunction(signature)!;
  return json(f.inputs.map((p, i) => abiValue(p, values[String(i)])));
}
