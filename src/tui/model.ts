import type { Context } from '../context.js';
import { COMMANDS, execute, findCommand, type Input } from '../commands.js';
import { json, safe, short, title } from '../values.js';
import type { CreationRecord } from '../deployments.js';

export const VIEWS = ['Discover', 'Overview', 'Proposals', 'Treasury', 'Members', 'Navigators', 'Activity', 'Journal', 'Tools', 'Settings'] as const;
export type View = typeof VIEWS[number];
export interface Row { key: string; label: string; detail: string; badge?: string; entity: Input; command?: string; input?: Input }
export interface ViewData { rows: Row[]; metrics: { label: string; value: string; detail: string }[]; source: string; nextOffset?: number | null; raw?: unknown }
const obj = (value: unknown): Input => value && typeof value === 'object' ? value as Input : {};
const metric = (label: string, value: unknown, detail = '') => ({ label, value: safe(value), detail });
export function proposalBadge(p: Input): string { return p.cancelled ? 'CANCELLED' : p.processed ? p.action_failed ? 'ACTION FAILED' : p.passed ? 'PASSED' : 'DEFEATED' : p.sponsored ? 'SPONSORED' : 'SUBMITTED'; }
export function filterRows(rows: Row[], search: string): Row[] {
  const terms = safe(search).toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter(row => terms.every(term => `${row.label} ${row.detail} ${row.badge ?? ''}`.toLowerCase().includes(term)));
}
export function windowRows<T>(items: T[], selected: number, size: number): { items: T[]; start: number; selected: number } {
  const cursor = Math.max(0, Math.min(selected, items.length - 1)); const start = Math.max(0, cursor - size + 1);
  return { items: items.slice(start, start + Math.max(1, size)), start, selected: cursor };
}
export function detailLines(value: unknown): string[] { return (json(value, true) ?? 'No data.').split('\n').map(safe); }
export async function loadView(ctx: Context, view: View, offset = 0): Promise<ViewData> {
  const page = { ...ctx.page(), offset, limit: 30 }, dao = ctx.flags.dao ? ctx.resolve(ctx.flags.dao) : ctx.config.daos[ctx.network];
  const result: ViewData = { rows: [], metrics: [], source: 'LOCAL WORKSPACE' };
  if (view === 'Tools') {
    result.rows = COMMANDS.map(c => ({ key: c.path, label: c.path, detail: c.description, badge: c.effect.toUpperCase(), entity: {}, command: c.path }));
    result.metrics = [metric('COMMANDS', COMMANDS.length), metric('CONTRACTS', 17), metric('INDEXED TABLES', 25)]; return result;
  }
  if (view === 'Settings') {
    result.rows = ['wallet list', 'wallet create', 'wallet import', 'wallet verify', 'wallet use', 'wallet export', 'wallet import-keystore', 'wallet change-password', 'wallet migrate', 'wallet watch', 'wallet remove', 'network use', 'alias set', 'alias remove', 'config show', 'doctor'].map(path => ({ key: path, label: title(path), detail: findCommand(path).description, entity: {}, command: path }));
    result.rows.unshift(...Object.entries(ctx.config.wallets).map(([name, profile]) => ({ key: `wallet:${name}`, label: name, detail: `${short(profile.address)} · Enter to select`, badge: profile.kind !== 'keystore' ? 'MIGRATE' : name === (ctx.flags.wallet ?? ctx.config.wallet) ? 'SELECTED' : 'ENCRYPTED', entity: { name, ...profile }, command: 'wallet use', input: { name } })));
    result.metrics = [metric('NETWORK', ctx.network), metric('WALLET', ctx.flags.wallet ?? ctx.config.wallet ?? 'Watch only'), metric('PROFILES', Object.keys(ctx.config.wallets).length)]; return result;
  }
  if (view === 'Journal') {
    const rawRecords = ctx.store.records(100, offset), rawCreations = ctx.store.documents<CreationRecord>('creation:', 100, offset);
    const records = rawRecords.filter(r => r.kind === 'transaction' && r.intent.chainId === ctx.chainId);
    result.rows = records.map(r => { if (r.kind !== 'transaction') throw Error('Invalid journal record'); return { key: r.id, label: r.intent.operation, detail: `${r.id} · ${short(r.hash ?? r.intent.to)}`, badge: r.status.toUpperCase(), entity: obj(r), command: 'tx show', input: { id: r.id } }; });
    const creations = rawCreations.filter(r => r.plan.chainId === ctx.chainId);
    result.rows.push(...creations.map(r => ({ key: r.id, label: `Deploy ${r.plan.kind}`, detail: `${r.id} · ${short(r.hash ?? r.plan.expectedAddress)}`, badge: r.status.toUpperCase(), entity: obj(r), command: 'tx show', input: { id: r.id } })));
    result.nextOffset = rawRecords.length === 100 || rawCreations.length === 100 ? offset + 100 : null;
    result.metrics = [metric('RECORDED', result.rows.length), metric('UNRESOLVED', result.rows.filter(r => !['MINED', 'REVERTED', 'NOT_SENT', 'CANCELLED', 'REPLACED'].includes(r.badge!)).length)]; return result;
  }
  if (view === 'Discover') {
    const pageResult = await ctx.indexer.list('daos', page);
    result.rows = pageResult.items.map(row => ({ key: row.id, label: row.name || 'Untitled DAO', detail: row.id, badge: row.id.toLowerCase() === dao?.toLowerCase() ? 'SELECTED' : '', entity: obj(row) }));
    result.nextOffset = pageResult.nextOffset;
    result.metrics = [metric('ON THIS PAGE', pageResult.items.length), metric('NETWORK', ctx.network, `Chain ${ctx.chainId}`), metric('WORKSPACE', dao ? short(dao, 5) : 'Choose a DAO', 'Enter opens the workspace')]; result.source = 'PUBLIC INDEXER · DISCOVERY'; return result;
  }
  if (!dao) return { ...result, metrics: [metric('START HERE', 'Choose a DAO', 'Open Discover, then press Enter')] };
  result.source = 'PUBLIC INDEXER · REFRESHES EVERY 15s';
  if (view === 'Overview') {
    const config = await ctx.chain.getDao(dao); result.raw = config; result.source = `ON CHAIN · BLOCK ${config.checkedAt.blockNumber}`;
    result.metrics = [metric('VOTING PERIOD', `${config.votingPeriod}s`, `Grace ${config.gracePeriod}s`), metric('QUORUM', `${config.quorumPercent} bps`), metric('OFFERING', config.proposalOffering, 'wei per proposal')];
    result.rows = Object.entries(config).filter(([key]) => key !== 'checkedAt').map(([key, value]) => ({ key, label: title(key), detail: safe(value), entity: { [key]: value } })); return result;
  }
  if (view === 'Treasury') {
    const treasury = await ctx.chain.getTreasury(dao); result.raw = treasury;
    result.source = `ON CHAIN · BLOCK ${treasury.checkedAt.blockNumber}`;
    result.metrics = [metric('ASSETS', treasury.tokens.length), metric('VAULT', short(treasury.avatar, 5), 'Registered treasury')];
    result.rows = treasury.tokens.map(token => ({ key: token.address, label: /^0x0{40}$/.test(token.address) ? 'QUAI' : short(token.address), detail: `${token.balance} base units`, entity: obj(token), command: 'token info', input: { address: token.address } })); return result;
  }
  const name = view === 'Proposals' ? 'proposal list' : view === 'Members' ? 'dao members' : view === 'Navigators' ? 'navigator list' : 'activity list';
  const reply = obj(await execute(new Proxy(ctx, { get(target, key) { if (key === 'page') return () => page; const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value; } }), findCommand(name), { dao }));
  const rows = reply.items as Input[] ?? []; result.nextOffset = reply.nextOffset as number | null;
  result.rows = rows.map(row => view === 'Proposals' ? { key: String(row.id), label: `#${row.proposal_id}  ${safe(row.details || 'Untitled proposal')}`, detail: `${row.yes_balance ?? 0} yes · ${row.no_balance ?? 0} no`, badge: proposalBadge(row), entity: row, command: 'proposal show', input: { proposal: row.proposal_id, dao } }
    : view === 'Members' ? { key: String(row.id), label: short(row.member_address), detail: `${row.shares ?? 0} shares · ${row.loot ?? 0} loot`, entity: row, command: 'dao member', input: { account: row.member_address, dao } }
    : view === 'Navigators' ? { key: String(row.id), label: title(String(row.navigator_type ?? 'Navigator')).replace(' Navigator', ''), detail: String(row.navigator_address), badge: String(row.trust_status ?? '').toUpperCase(), entity: row, command: 'navigator show', input: { address: row.navigator_address, dao } }
    : { key: String(row.id), label: safe(row.event_name ?? row.tx_hash ?? row.id), detail: `Block ${row.block_number ?? '—'} · ${short(row.tx_hash ?? row.id)}`, entity: row });
  result.metrics = [metric('ON THIS PAGE', rows.length), metric('DAO', short(dao, 5)), metric('ACCOUNT', ctx.config.address ? short(ctx.config.address, 5) : 'Watch any address')];
  return result;
}
