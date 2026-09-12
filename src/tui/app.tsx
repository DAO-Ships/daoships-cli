import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, render, useApp, useInput, usePaste, useWindowSize } from 'ink';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import type { ContractName, NavigatorKind } from '@daoships/sdk';
import { Context } from '../context.js';
import { COMMANDS, constructorFields, contractKind, contractMethods, execute, findCommand, formArgs, methodFields, type CommandSpec, type Field, type Input } from '../commands.js';
import { errorInfo, json, readJsonInput, safe, short } from '../values.js';
import { spawnAction, spawnCommand } from './child.js';
export { spawnAction } from './child.js';
import { VIEWS, detailLines, filterRows, loadView, windowRows, type Row, type View, type ViewData } from './model.js';

const C = { accent: '#72E5D1', gold: '#FFD28A', muted: '#83949C', line: '#354851', white: '#E8F1F2', red: '#FF9090', green: '#92D89F' };
interface Form { spec: CommandSpec; fields: Field[]; values: string[]; field: number; cursor: number; navigator?: NavigatorKind; abi?: { kind: ContractName; address: string; signature: string } }
type Modal = { type: 'help' } | { type: 'palette'; query: string; selected: number; target?: { kind: ContractName; address: string } }
  | { type: 'form'; form: Form } | { type: 'detail'; title: string; data: unknown; offset: number; row?: Row; back?: Extract<Modal, { type: 'review' }> }
  | { type: 'review'; data: Input; spec: CommandSpec; input: Input; id: string };
const empty: ViewData = { rows: [], metrics: [], source: 'CONNECTING' };

export function Screen({ width, height, view, data, selected, search, searching, busy, network, dao, notice, updated, children }: {
  width: number; height: number; view: View; data: ViewData; selected: number; search: string; searching: boolean; busy: string;
  network: string; dao?: string; notice: string; updated?: number; children?: React.ReactNode;
}) {
  const wide = width >= 100, rows = filterRows(data.rows, search), visible = windowRows(rows, selected, Math.max(2, Math.floor((height - 15) / 2)));
  if (width < 58 || height < 24) return <Box flexDirection="column"><Text color={C.accent}>DAOShips · {network}</Text><Text>A little more room, please: 58 columns × 24 rows.</Text><Text dimColor>Resize the terminal. Press q to leave.</Text></Box>;
  return <Box width={width} height={height - 1} flexDirection="column" paddingX={1}>
    <Box justifyContent="space-between" paddingTop={1}><Text bold color={C.accent}>◈  DAOShips <Text color={C.muted}>/ collective decisions</Text></Text><Text color={network === 'mainnet' ? C.gold : C.accent}>● {network.toUpperCase()}</Text></Box>
    <Box marginBottom={1} justifyContent="space-between"><Text color={C.muted}>{dao ? `Workspace  ${short(dao, 7)}` : 'Find your people. Shape what comes next.'}</Text><Text color={C.muted}>{busy ? `◌ ${busy}` : updated ? '● Updated ' + new Date(updated).toLocaleTimeString() : '○ Ready'}</Text></Box>
    <Box flexGrow={1}>
      {wide && <Box width={22} flexDirection="column" borderStyle="single" borderColor={C.line} borderLeft={false} borderTop={false} borderBottom={false} paddingRight={2}>
        <Text color={C.muted}>YOUR WORKSPACE</Text><Text> </Text>
        {VIEWS.map((name, i) => <Box key={name} marginBottom={height >= 34 ? 1 : 0}><Text bold={view === name} color={view === name ? C.accent : C.muted}>{view === name ? '▎' : ' '} {i === 9 ? '0' : i + 1}  {name}</Text></Box>)}
        <Box flexGrow={1}/><Text color={C.muted}>Ctrl K  Commands</Text><Text color={C.muted}>?       Key guide</Text>
      </Box>}
      <Box flexDirection="column" flexGrow={1} width={wide ? width - 26 : width - 2} paddingLeft={wide ? 2 : 0}>
        {children ?? <>
          <Box justifyContent="space-between"><Text bold color={C.white}>{view}</Text><Text color={C.muted}>{data.source}</Text></Box>
          {!!data.metrics.length && <Box height={height > 28 ? 5 : 4} flexShrink={0} marginTop={1} marginBottom={1} gap={2}>{data.metrics.slice(0, width < 80 ? 2 : 3).map(item => <Box key={item.label} height={height > 28 ? 5 : 4} flexDirection="column" flexGrow={1} borderStyle="round" borderColor={C.line} paddingX={1}><Box height={1} flexShrink={0}><Text color={C.muted}>{item.label}</Text></Box><Box height={1} flexShrink={0}><Text bold color={C.accent} wrap="truncate-end">{item.value}</Text></Box>{height > 28 && <Box height={1} flexShrink={0}><Text color={C.muted} wrap="truncate-end">{item.detail || ' '}</Text></Box>}</Box>)}</Box>}
          {(searching || search) && <Box marginBottom={1}><Text color={C.accent}>/ </Text><Text>{safe(search)}{searching ? '▌' : ''}</Text><Text color={C.muted}>  {rows.length} matches</Text></Box>}
          {!rows.length && <Box flexDirection="column" paddingY={2}><Text color={C.white}>{busy ? 'Gathering your workspace…' : search ? 'No matches on this page.' : 'Nothing here yet.'}</Text><Text color={C.muted}>{search ? 'Try a different word or press Escape to clear.' : view === 'Journal' ? 'Preview an action; submitted transactions will appear here.' : !dao && view !== 'Discover' ? 'Open Discover and select a DAO to get started.' : 'Press Ctrl K to explore the commands available here.'}</Text></Box>}
          {visible.items.map((row, i) => <Box key={row.key} flexDirection="column" height={2} flexShrink={0}><Box height={1} flexShrink={0} justifyContent="space-between"><Text color={visible.start + i === visible.selected ? C.accent : C.white} bold={visible.start + i === visible.selected} wrap="truncate-end">{visible.start + i === visible.selected ? '› ' : '  '}{safe(row.label)}</Text><Text color={/FAILED|REVERT|UNKNOWN/.test(row.badge ?? '') ? C.red : /PASSED|MINED|SELECTED/.test(row.badge ?? '') ? C.green : C.gold}> {safe(row.badge)}</Text></Box><Box height={1} flexShrink={0}><Text color={C.muted} wrap="truncate-end">  {safe(row.detail)}</Text></Box></Box>)}
          <Box flexGrow={1}/><Box justifyContent="space-between"><Text color={C.muted}>{rows.length ? `${visible.selected + 1} / ${rows.length} · ↑↓ or j/k` : ' '}</Text><Text color={C.muted}>{data.nextOffset != null ? 'n Next page   b Previous' : ''}</Text></Box>
        </>}
      </Box>
    </Box>
    <Box marginTop={1}><Text color={notice.startsWith('Error') ? C.red : C.gold} wrap="truncate-end">{notice || ' '}</Text></Box>
    <Box height={2} flexShrink={0} borderStyle="single" borderColor={C.line} borderBottom={false} borderLeft={false} borderRight={false} justifyContent="space-between"><Text color={C.muted}>{width < 90 ? 'Enter Open · / Filter · a Actions · Tab Views' : 'Enter Open   / Filter   a Actions   + Create   r Refresh'}</Text><Text color={C.muted}>q Quit</Text></Box>
  </Box>;
}

function FormView({ form, width, height }: { form: Form; width: number; height: number }) {
  const f = form.fields[form.field], value = form.values[form.field] ?? '';
  const start = Math.max(0, form.cursor - Math.max(16, width - 15));
  return <Box flexDirection="column" flexGrow={1}>
    <Text bold color={C.accent}>{form.spec.path}</Text><Text color={C.muted} wrap="truncate-end">{form.spec.description}</Text><Text> </Text>
    <Text color={C.muted}>STEP {form.field + 1} OF {form.fields.length}  ·  {form.spec.effect === 'write' ? 'Preview before signing' : 'Fill in the details'}</Text><Text> </Text>
    {form.fields.slice(Math.max(0, form.field - (height > 30 ? 2 : 1)), form.field + 1).map((field, i) => {
      const index = Math.max(0, form.field - (height > 30 ? 2 : 1)) + i;
      return index === form.field ? <Box key={field.name} height={height > 30 ? 8 : 6} flexShrink={0} flexDirection="column" borderStyle="round" borderColor={C.accent} paddingX={1} paddingY={height > 30 ? 1 : 0}><Text bold color={C.white}>{field.label}{field.optional ? ' · optional' : ''}</Text><Text> </Text>
        {field.choices ? <Text color={C.accent}>‹ {safe(value)} ›</Text> : <Text color={C.accent} wrap="truncate-end">{start > 0 ? '…' : ''}{safe(value.slice(start, form.cursor))}<Text inverse> </Text>{safe(value.slice(form.cursor))}</Text>}
        <Text color={C.muted} wrap="truncate-end">{field.hint ?? (field.type === 'json' ? 'Paste JSON, or type @ followed by a file path.' : field.type === 'address' ? 'Paste an address or use a saved alias.' : ' ')}</Text></Box>
        : <Text key={field.name} color={C.muted} wrap="truncate-end">✓ {field.label}  {safe(form.values[index]) || 'default'}</Text>;
    })}
    <Box flexGrow={1}/><Text color={C.muted}>{f?.choices ? '← → Choose · ' : ''}Enter {form.field === form.fields.length - 1 ? 'Review' : 'Continue'}   Tab Next field   Shift Tab Back   Ctrl U Clear   Esc Close</Text>
  </Box>;
}
export function App({ initialContext, reconfigure }: { initialContext: Context; reconfigure(changeNetwork?: boolean): Promise<Context> }) {
  const { exit, suspendTerminal } = useApp(), size = useWindowSize();
  const width = size.columns || 100, height = size.rows || 30;
  const [ctx, setCtx] = useState(initialContext), [view, setView] = useState<View>('Discover');
  const [data, setData] = useState<ViewData>(empty), [selected, setSelected] = useState(0), [offset, setOffset] = useState(0);
  const pages = useRef<number[]>([]);
  const [search, setSearch] = useState(''), [searching, setSearching] = useState(false), [modal, setModal] = useState<Modal>();
  const [busy, setBusy] = useState(''), [notice, setNotice] = useState(''), [updated, setUpdated] = useState<number>(), [revision, setRevision] = useState(0);
  const generation = useRef(0), acting = useRef(false), lifetime = useRef(new AbortController());
  const visible = filterRows(data.rows, search), row = visible[Math.min(selected, visible.length - 1)];
  const refresh = () => setRevision(v => v + 1);
  const selectedDao = ctx.flags.dao ?? ctx.config.daos[ctx.network];
  const selectedAddress = () => { try { return ctx.from(); } catch { return undefined; } };
  async function inTerminal<T>(work: () => Promise<T>): Promise<T> {
    let result!: T; await suspendTerminal(async () => { result = await work(); }); return result;
  }
  useEffect(() => {
    const stop = () => { lifetime.current.abort(); exit(); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    return () => { lifetime.current.abort(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); };
  }, [exit]);
  useEffect(() => {
    const token = ++generation.current; let alive = true, loading = false;
    const load = async () => {
      if (loading || acting.current || !alive) return; loading = true; setBusy('Refreshing');
      try { const result = await loadView(ctx, view, offset); if (alive && generation.current === token) { setData(result); setUpdated(Date.now()); } }
      catch (error) { if (alive && generation.current === token) setNotice(`Error · ${errorInfo(error).message}`); }
      finally { loading = false; if (alive && generation.current === token) setBusy(''); }
    };
    void load(); const timer = setInterval(() => { void load(); }, 15_000);
    return () => { alive = false; clearInterval(timer); };
  }, [ctx, view, offset, revision]);
  function choose(next: View) { pages.current = []; setView(next); setSelected(0); setOffset(0); setSearch(''); setSearching(false); setModal(undefined); setData(empty); setNotice(''); }
  async function run(spec: CommandSpec, input: Input, detailRow?: Row) {
    if (acting.current) return; acting.current = true; setBusy(spec.effect === 'write' ? 'Simulating' : 'Loading'); setNotice('');
    try {
      const result = spec.secret ? await inTerminal(() => spawnCommand(ctx, spec, input, lifetime.current.signal, true)) : await execute(ctx, spec, input);
      if (['wallet create', 'wallet import', 'wallet import-keystore', 'wallet migrate', 'wallet use', 'wallet watch', 'wallet remove'].includes(spec.path)) { delete ctx.flags.wallet; delete ctx.flags.from; }
      if (spec.path === 'dao use') delete ctx.flags.dao;
      if (result && typeof result === 'object' && 'mode' in result && result.mode === 'preview') setModal({ type: 'review', data: result as Input, spec, input, id: randomUUID() });
      else {
        if (spec.secret) { const next = await reconfigure(); setCtx(next); setModal({ type: 'detail', title: spec.path, data: result, offset: 0 }); refresh(); }
        else if (spec.path === 'network use') { const next = await reconfigure(true); setCtx(next); choose('Discover'); }
        else if (['wallet watch', 'wallet import', 'wallet use', 'wallet remove', 'alias set', 'alias remove', 'dao use'].includes(spec.path)) { setModal(undefined); setNotice('Saved · ' + spec.description); refresh(); }
        else setModal({ type: 'detail', title: spec.path, data: result, offset: 0, row: detailRow });
      }
    } catch (error) { const info = errorInfo(error); setNotice(`Error · ${info.message}${info.details.id ? ' · ID ' + info.details.id : ''}`); }
    finally { acting.current = false; setBusy(''); }
  }
  function openForm(spec: CommandSpec, input: Input = {}, abi?: Form['abi']) {
    setNotice('');
    const fields = (abi ? methodFields(abi.kind, abi.signature) : spec.path === 'navigator deploy' ? [spec.fields[0]!] : spec.fields).map(f => {
      if (f.name !== 'name' || !['wallet use', 'wallet export', 'wallet verify', 'wallet change-password', 'wallet migrate', 'wallet remove'].includes(spec.path)) return f;
      const names = Object.keys(ctx.config.wallets).filter(name => spec.path !== 'wallet migrate' || ctx.config.wallets[name]?.kind !== 'keystore');
      return names.length ? { ...f, type: 'choice' as const, choices: names, default: names.includes(ctx.config.wallet ?? '') ? ctx.config.wallet : names[0] } : f;
    });
    if (abi && contractMethods(abi.kind).find(m => m.signature === abi.signature)?.payable) fields.push({ name: 'value', label: 'Native value (wei)', default: '0', optional: true, type: 'number' });
    const values = fields.map(f => {
      const fromContext = f.context === 'dao' ? selectedDao : f.context === 'from' ? selectedAddress() : undefined;
      const value = input[f.name] ?? fromContext ?? f.default ?? f.choices?.[0] ?? '';
      return typeof value === 'object' ? json(value) : String(value);
    });
    if (!fields.length) { void run(spec, abi ? { kind: abi.kind, address: abi.address, method: abi.signature, args: '[]' } : {}, row); return; }
    setModal({ type: 'form', form: { spec, fields, values, field: 0, cursor: values[0]?.length ?? 0, abi } });
  }
  async function submitForm(form: Form) {
    const input: Input = {};
    try {
      for (const [i, f] of form.fields.entries()) { const value = form.values[i]; if (value !== '') input[f.name] = f.type === 'address' ? ctx.resolve(value!) : (form.abi || form.navigator) && f.type === 'json' ? await readJsonInput(value!) : value; }
      if (form.spec.path === 'navigator deploy' && !form.navigator) {
        const navigator = input.kind as NavigatorKind, fields = [...constructorFields(navigator), form.spec.fields[2]!];
        const values = fields.map(f => f.context === 'dao' ? selectedDao ?? '' : f.default ?? f.choices?.[0] ?? '');
        setModal({ type: 'form', form: { ...form, fields, values, field: 0, cursor: values[0]!.length, navigator } }); return;
      }
      const { options, ...config } = input;
      await run(form.spec, form.navigator ? { kind: form.navigator, config, options: options ?? {} } : form.abi ? { kind: form.abi.kind, address: form.abi.address, method: form.abi.signature, args: formArgs(form.abi.kind, form.abi.signature, input), ...(form.spec.effect === 'write' ? { value: input.value ?? '0' } : {}) } : input, row);
    } catch (error) { setNotice('Error · ' + errorInfo(error).message); }
  }
  function edit(input: string) {
    const clean = safe(input.replace(/[\r\n]+/g, ' '));
    if (modal?.type === 'form') setModal(current => {
      if (current?.type !== 'form') return current; const f = current.form;
      if (f.fields[f.field]?.choices) return current;
      const value = f.values[f.field] ?? '', next = value.slice(0, f.cursor) + clean + value.slice(f.cursor);
      if (next.length > 262_144) return current;
      return { type: 'form', form: { ...f, values: f.values.map((v, i) => i === f.field ? next : v), cursor: f.cursor + clean.length } };
    });
    else if (modal?.type === 'palette') setModal({ ...modal, query: (modal.query + clean).slice(0, 200), selected: 0 });
    else if (searching) { setSearch(value => (value + clean).slice(0, 200)); setSelected(0); }
  }
  usePaste(text => { if (!acting.current) edit(text); });
  const paletteItems = modal?.type === 'palette' ? (modal.target
    ? contractMethods(modal.target.kind).map(m => ({ label: m.signature, detail: `${m.effect} · ${m.inputs.length} inputs`, effect: m.effect, signature: m.signature }))
    : COMMANDS.map(c => ({ label: c.path, detail: c.description, effect: c.effect, signature: '' })))
    .filter(item => `${item.label} ${item.detail}`.toLowerCase().includes(modal.query.toLowerCase())) : [];
  useInput((input, key) => {
    if (key.ctrl && input === 'c') { lifetime.current.abort(); exit(); return; }
    if (acting.current) return;
    if (modal?.type === 'form') {
      const f = modal.form, field = f.fields[f.field]!, value = f.values[f.field] ?? '';
      const set = (patch: Partial<Form>) => setModal({ type: 'form', form: { ...f, ...patch } });
      if (key.escape) { setModal(undefined); setNotice(''); }
      else if (key.return) { if (f.field < f.fields.length - 1) set({ field: f.field + 1, cursor: f.values[f.field + 1]!.length }); else void submitForm(f); }
      else if (key.tab || key.upArrow || key.downArrow) { const next = (f.field + (key.shift || key.upArrow ? -1 : 1) + f.fields.length) % f.fields.length; set({ field: next, cursor: f.values[next]!.length }); }
      else if (field.choices && (key.leftArrow || key.rightArrow || input === ' ')) { const options = field.choices, next = options[(Math.max(0, options.indexOf(value)) + (key.leftArrow ? -1 : 1) + options.length) % options.length]!; set({ values: f.values.map((v, i) => i === f.field ? next : v), cursor: next.length }); }
      else if (key.ctrl && input === 'u') set({ values: f.values.map((v, i) => i === f.field ? '' : v), cursor: 0 });
      else if (key.ctrl && input === 'a') set({ cursor: 0 });
      else if (key.ctrl && input === 'e') set({ cursor: value.length });
      else if (key.leftArrow) set({ cursor: Math.max(0, f.cursor - 1) });
      else if (key.rightArrow) set({ cursor: Math.min(value.length, f.cursor + 1) });
      else if (key.backspace || key.delete) { const before = key.backspace ? Math.max(0, f.cursor - 1) : f.cursor; set({ values: f.values.map((v, i) => i === f.field ? v.slice(0, before) + v.slice(before + 1) : v), cursor: before }); }
      else if (!key.ctrl && !key.meta) edit(input);
      return;
    }
    if (modal?.type === 'palette') {
      if (key.escape) setModal(undefined);
      else if (key.upArrow || key.downArrow) setModal({ ...modal, selected: Math.max(0, Math.min(paletteItems.length - 1, modal.selected + (key.upArrow ? -1 : 1))) });
      else if (key.backspace || key.delete) setModal({ ...modal, query: modal.query.slice(0, -1), selected: 0 });
      else if (key.return) { const item = paletteItems[modal.selected]; if (item) modal.target ? openForm(findCommand(`contract ${item.effect}`), {}, { ...modal.target, signature: item.signature }) : openForm(findCommand(item.label), row?.input ?? {}); }
      else if (!key.ctrl && !key.meta) edit(input);
      return;
    }
    if (modal?.type === 'review') {
      if (key.escape) { setModal(undefined); setNotice('Preview closed.'); }
      else if (input === 'd') setModal({ type: 'detail', title: 'Complete transaction preview', data: modal.data, offset: 0, back: modal });
      else if (input === 's') {
        const pending = modal; acting.current = true; setBusy('Signing and confirming'); setNotice('Transaction recovery ID · ' + pending.id);
        void inTerminal(() => spawnAction(ctx, pending.spec, pending.input, pending.data, pending.id, lifetime.current.signal, true)).then(async result => {
          setModal({ type: 'detail', title: 'Transaction confirmed', data: result, offset: 0 });
          const next = await reconfigure(); setCtx(next); setNotice('Confirmed · Saved in your journal'); refresh();
        }).catch(error => { const info = errorInfo(error); setModal({ type: 'detail', title: 'Transaction outcome', data: info, offset: 0 }); setNotice(info.message + ' · ' + pending.id); })
          .finally(() => { acting.current = false; setBusy(''); });
      }
      return;
    }
    if (modal?.type === 'detail') {
      if (key.escape) setModal(modal.back);
      else if (key.upArrow || input === 'k') setModal({ ...modal, offset: Math.max(0, modal.offset - 1) });
      else if (key.downArrow || input === 'j') setModal({ ...modal, offset: Math.min(Math.max(0, detailLines(modal.data).length - 5), modal.offset + 1) });
      else if (key.pageDown || key.pageUp) setModal({ ...modal, offset: Math.max(0, modal.offset + (key.pageUp ? -1 : 1) * Math.max(5, height - 12)) });
      else if (input === 'e') {
        const path = `daoships-${Date.now()}.json`; void writeFile(path, json(modal.data, true) + '\n', { flag: 'wx', mode: 0o600 }).then(() => setNotice('Exported · ' + path)).catch(error => setNotice('Error · ' + errorInfo(error).message));
      } else if (view === 'Proposals' && ['y', 'n', 's', 'p', 'x'].includes(input)) {
        const base = modal.row?.input ?? row?.input ?? {};
        openForm(findCommand(input === 'y' || input === 'n' ? 'proposal vote' : input === 's' ? 'proposal sponsor' : input === 'p' ? 'proposal process' : 'proposal cancel'), { ...base, ...(input === 'y' || input === 'n' ? { vote: input === 'y' ? 'yes' : 'no' } : {}) });
      } else if (input === 'a') {
        const entity = modal.data as Input;
        try { const kind = contractKind(view === 'Navigators' ? entity.kind : view === 'Treasury' ? 'SharesERC20' : 'DAOShip');
          setModal({ type: 'palette', query: '', selected: 0, target: { kind, address: ctx.resolve(String(entity.address ?? selectedDao)) } });
        } catch (error) { setNotice('Error · ' + errorInfo(error).message); }
      } else if (view === 'Journal' && input === 'r') openForm(findCommand('tx recover'), { id: modal.row?.entity.id ?? row?.entity.id });
      return;
    }
    if (modal?.type === 'help') { if (key.escape || input === '?' || input === 'q') setModal(undefined); return; }
    if (searching) {
      if (key.escape) { setSearching(false); setSearch(''); }
      else if (key.return) setSearching(false);
      else if (key.backspace || key.delete) setSearch(value => value.slice(0, -1));
      else if (!key.ctrl && !key.meta) edit(input);
      return;
    }
    if (input === 'q') { exit(); return; }
    if (key.ctrl && input === 'k') { setModal({ type: 'palette', query: '', selected: 0 }); return; }
    if (key.tab) { choose(VIEWS[(VIEWS.indexOf(view) + (key.shift ? -1 : 1) + VIEWS.length) % VIEWS.length]!); return; }
    if (/^[0-9]$/.test(input)) { choose(VIEWS[input === '0' ? 9 : Number(input) - 1]!); return; }
    if (key.escape) { setSearch(''); return; }
    if (input === '/') { setSearching(true); return; }
    if (input === '?') { setModal({ type: 'help' }); return; }
    if (input === 'r') { setNotice(''); refresh(); return; }
    if (input === 'n' && data.nextOffset != null) { pages.current.push(offset); setOffset(data.nextOffset); setSelected(0); return; }
    if (input === 'b') { setOffset(pages.current.pop() ?? 0); setSelected(0); return; }
    if (input === '+') { openForm(findCommand(view === 'Settings' ? 'wallet import' : view === 'Navigators' ? 'navigator deploy' : 'proposal submit')); return; }
    if (input === 'a' && selectedDao) {
      try { const kind = contractKind(view === 'Navigators' && row ? row.entity.navigator_type : 'DAOShip');
        const address = ctx.resolve(view === 'Navigators' && row ? String(row.entity.navigator_address) : selectedDao!);
        setModal({ type: 'palette', query: '', selected: 0, target: { kind, address } });
      } catch (error) { setNotice('Error · ' + errorInfo(error).message); } return;
    }
    if (key.upArrow || input === 'k') setSelected(value => Math.max(0, value - 1));
    else if (key.downArrow || input === 'j') setSelected(value => Math.min(visible.length - 1, value + 1));
    else if (key.return && row) {
      if (view === 'Discover') { ctx.config.daos[ctx.network] = ctx.resolve(String(row.entity.id)); delete ctx.flags.dao; ctx.save(); choose('Overview'); }
      else if (view === 'Tools' || view === 'Settings') openForm(findCommand(row.command!), row.input);
      else if (row.command && !(view === 'Treasury' && /^0x0{40}$/.test(row.key))) void run(findCommand(row.command), row.input ?? {}, row);
      else setModal({ type: 'detail', title: row.label, data: row.entity, offset: 0, row });
    }
  });
  let content: React.ReactNode;
  if (modal?.type === 'form') content = <FormView form={modal.form} width={width - (width >= 100 ? 26 : 2)} height={height}/>;
  else if (modal?.type === 'palette') {
    const page = windowRows(paletteItems, modal.selected, Math.max(3, Math.floor((height - 16) / 2)));
    content = <Box flexDirection="column" flexGrow={1}><Text bold color={C.accent}>{modal.target ? `${modal.target.kind} · ${short(modal.target.address, 5)}` : 'Go anywhere. Do anything.'}</Text><Box height={3} flexShrink={0} borderStyle="round" borderColor={C.accent} paddingX={1} marginY={1}><Text color={C.white}>⌕ {safe(modal.query)}▌</Text></Box>
      {page.items.map((item, i) => <Box key={item.label} flexDirection="column" height={2} flexShrink={0}><Box height={1} flexShrink={0}><Text bold={page.start + i === modal.selected} color={page.start + i === modal.selected ? C.accent : C.white} wrap="truncate-end">{page.start + i === modal.selected ? '› ' : '  '}{item.label}</Text></Box><Box height={1} flexShrink={0}><Text color={C.muted} wrap="truncate-end">  {item.detail}</Text></Box></Box>)}
      <Box flexGrow={1}/><Text color={C.muted}>{paletteItems.length} commands · Type to search · ↑↓ Select · Enter Open · Esc Back</Text></Box>;
  } else if (modal?.type === 'review') {
    const tx = modal.data.transaction as Input;
    const fields = [['Network', `${ctx.network} · chain ${tx.chainId}`], ['Action', tx.operation], ['From', tx.from], ['To', tx.to], ['Value', `${tx.value} wei + fees`], ['Recovery ID', modal.id], ...(height > 30 ? [['At block', (tx.checkedAt as Input)?.blockNumber], ['Review', modal.data.reviewHash]] : [])];
    content = <Box flexDirection="column" flexGrow={1}><Text bold color={C.gold}>Review your transaction</Text>
      <Box height={fields.length + 2} flexShrink={0} borderStyle="round" borderColor={C.gold} paddingX={1} flexDirection="column" marginY={1}>
        {fields.map(([name, value]) => <Box height={1} flexShrink={0} key={String(name)}><Box width={13}><Text color={C.muted}>{String(name)}</Text></Box><Text color={C.white} wrap="truncate-end">{safe(value)}</Text></Box>)}
      </Box><Text color={C.muted}>Calldata · {Math.max(0, (String(tx.data).length - 2) / 2)} bytes · d Full details</Text><Box flexGrow={1}/><Text bold color={C.gold}>s  Sign and send</Text><Text color={C.muted}>Esc Back · Exact intent is rechecked before signing.</Text></Box>;
  } else if (modal?.type === 'detail') {
    const lines = detailLines(modal.data), visible = lines.slice(modal.offset, modal.offset + Math.max(4, height - 12));
    content = <Box flexDirection="column" flexGrow={1}><Text bold color={C.accent}>{modal.title}</Text><Text color={C.muted}>Exact values · {lines.length} lines · e Export JSON</Text><Text> </Text>
      {visible.map((line, i) => <Text key={i} color={C.white} wrap="truncate-end">{line || ' '}</Text>)}<Box flexGrow={1}/>
      <Text color={C.gold}>{view === 'Proposals' ? 'y Vote yes · n Vote no · s Sponsor · p Process · x Cancel' : view === 'Journal' ? 'r Reconcile from chain' : 'a Contract actions'}</Text><Text color={C.muted}>↑↓ Scroll · PgUp/PgDn Page · Esc Back</Text></Box>;
  } else if (modal?.type === 'help') content = <Box flexDirection="column"><Text bold color={C.accent}>Make yourself at home.</Text><Text> </Text>{[
    '1–9, 0      Jump to a workspace section', 'Tab          Cycle sections · Shift Tab goes back', '↑↓ or j/k    Move through lists', 'Enter        Open the selected item', '/            Filter the current page', 'Ctrl K       Search every one-shot command', 'a            Explore all contract reads and writes', '+            Create a proposal or navigator', 'r            Refresh · live views refresh every 15s', 'n / b        Next / previous results page', 'e            Export a detail view as exact JSON', 'Esc          Close a panel or clear a filter', 'q / Ctrl C   Leave the workspace', '', 'Writes open a review. Press s there to sign.', 'Pending transactions remain in Journal after exit.', 'No key is needed to browse. Settings adds a wallet.',
  ].map((line, i) => <Text key={i} color={i > 13 ? C.gold : C.white}>{line || ' '}</Text>)}</Box>;
  return <Screen width={width} height={height} view={view} data={data} selected={selected} search={search} searching={searching} busy={busy} network={ctx.network} dao={selectedDao} notice={notice} updated={updated}>{content}</Screen>;
}
export async function startTui(context: Context): Promise<void> {
  context.flags.send = false;
  let active = context;
  const app = render(<App initialContext={context} reconfigure={async (changeNetwork) => {
    const previous = active; active = await Context.open({ ...previous.flags, network: changeNetwork ? previous.config.network : previous.network, configDir: previous.store.directory }); previous.close(); return active;
  }}/>, { alternateScreen: true, exitOnCtrlC: false });
  try { await app.waitUntilExit(); } finally { app.unmount(); active.close(); }
}
