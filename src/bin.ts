#!/usr/bin/env node
import { Command, CommanderError, Option } from 'commander';
import { open, readFile } from 'node:fs/promises';
import { COMMANDS, execute, findCommand, type CommandSpec, type Input } from './commands.js';
import { Context, type Flags } from './context.js';
import { CliError, errorInfo, json, readJsonInput, safe } from './values.js';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
export function schema() {
  return { schemaVersion: 1, name: 'daoships', version: manifest.version,
    envelope: { schemaVersion: 1, ok: 'boolean', command: 'string', network: 'orchard | mainnet', chainId: 'integer', data: 'command result; bigint values are decimal strings', error: '{code,message,details} on failure' },
    exitCodes: { 0: 'success', 1: 'connection or internal failure', 2: 'usage', 3: 'precondition or business outcome failed', 4: 'transaction outcome requires recovery', 5: 'declined', 130: 'interrupted' },
    execution: 'Writes preview by default. Use --send --yes --id <stable-id> to execute. The same ID never silently resends a transaction.',
    commands: COMMANDS.map(({ run: _run, ...definition }) => definition),
    flags: ['--network', '--rpc', '--dao', '--from', '--wallet', '--key-env-file', '--password-file', '--new-password-file', '--key-file', '--allow-weak-keystore', '--config-dir', '--json', '--send', '--yes', '--id', '--expect-hash', '--timeout', '--confirmations', '--max-value', '--max-gas', '--limit', '--offset', '--output'] };
}
function human(value: unknown): string {
  if (value && typeof value === 'object' && 'items' in value && Array.isArray(value.items)) {
    const page = value as { items: unknown[]; nextOffset?: number | null };
    if (!page.items.length) return 'No results.';
    return page.items.map((row, i) => `${i + 1}. ${json(row, true)}`).join('\n\n') + (page.nextOffset == null ? '' : `\n\nNext page: --offset ${page.nextOffset}`);
  }
  return json(value, true) ?? 'Done.';
}
export async function main(argv = process.argv): Promise<void> {
  const program = new Command().name('daoships').description('Your DAOShips terminal workspace · one-shot commands and an interactive TUI').version(manifest.version)
    .addOption(new Option('--network <network>', 'orchard or mainnet').choices(['orchard', 'testnet', 'mainnet']))
    .option('--rpc <url>', 'Override the selected network’s RPC')
    .option('--dao <address>', 'DAO address or alias').option('--from <address>', 'Public sender address or alias')
    .option('--wallet <name>', 'Encrypted wallet profile').option('--key-env-file <file>', 'Private dotenv file for explicit key import or migration')
    .option('--password-file <file>', 'Owner-only file containing the keystore password')
    .option('--new-password-file <file>', 'Owner-only file containing the replacement password for restore/change-password')
    .option('--key-file <file>', 'Owner-only private key file for wallet import')
    .option('--allow-weak-keystore', 'Allow a weak KDF only while importing and re-encrypting a keystore')
    .option('--config-dir <directory>', 'Configuration and recovery database directory')
    .option('--json', 'Versioned JSON output for agents').option('--schema', 'Print the command and output contract')
    .option('--send', 'Execute a write after reviewing its current simulation').option('--yes', 'Approve execution without a prompt')
    .option('--id <id>', 'Stable operation ID; required for non-interactive sends')
    .option('--expect-hash <hash>', 'Require this reviewed transaction hash')
    .option('--timeout <ms>', 'RPC and confirmation timeout, up to 300000 ms')
    .option('--confirmations <count>', 'Receipt confirmation depth (default 2)')
    .option('--max-value <wei>', 'Maximum native transaction value').option('--max-gas <units>', 'Gas limit ceiling (default 10000000)')
    .option('--limit <rows>', 'Page size (default 50)').option('--offset <rows>', 'Page offset')
    .option('--output <file>', 'Save the result as JSON to a new file')
    .showHelpAfterError().exitOverride().configureOutput({ outputError: () => {} });
  let command = 'help', flags: Flags & { output?: string } = {}, context: Context | undefined;
  const interrupt = () => context?.abort.abort();
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  async function run(spec: CommandSpec, input: Input, cli: Command) {
    flags = cli.optsWithGlobals(); command = spec.path;
    context = await Context.open(flags);
    const output = flags.output ? await open(flags.output, 'wx', 0o600) : undefined;
    try {
      const data = await execute(context, spec, input);
      const result = { schemaVersion: 1, ok: true, command, network: context.network, chainId: context.chainId, data };
      if (output) await output.writeFile(json(result, true) + '\n');
      process.stdout.write((flags.json ? json(result) : `${safe(spec.description)}\n\n${human(data).split('\n').map(safe).join('\n')}`) + '\n');
    } catch (error) {
      if (output) { const { code, message, details } = errorInfo(error); await output.writeFile(json({ schemaVersion: 1, ok: false, command, error: { code, message, details } }, true) + '\n').catch(() => {}); }
      throw error;
    } finally { await output?.close(); }
  }
  const groups = new Map<string, Command>();
  for (const spec of COMMANDS) {
    const [group, verb] = spec.path.split(' ');
    let parent = program;
    if (verb) { if (!groups.has(group!)) groups.set(group!, program.command(group!).description(`${group} commands`)); parent = groups.get(group!)!; }
    const cli = parent.command(verb ?? group!).description(spec.description);
    for (const f of spec.fields) cli.argument(f.optional ? `[${f.name}]` : `<${f.name}>`, `${f.label}${f.hint ? ' · ' + f.hint : ''}`);
    cli.action(async (...values: unknown[]) => { const input: Input = {}; spec.fields.forEach((f, i) => { if (values[i] !== undefined) input[f.name] = values[i]; }); await run(spec, input, cli); });
  }
  program.command('run').description('Run a discovered command with a JSON input object').argument('<command>').argument('[input]', 'JSON object or @file.json', '{}').action(async (path: string, input: string, _options: unknown, cli: Command) => {
    const value = await readJsonInput(input); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CliError('USAGE', 'run input must be a JSON object.');
    await run(findCommand(path), value as Input, cli);
  });
  program.command('schema').description('Print all commands, input fields and exit codes').action(() => { process.stdout.write(json(schema(), true) + '\n'); });
  program.command('tui').description('Open the interactive DAOShips workspace').action(async (_options: unknown, cli: Command) => {
    flags = cli.optsWithGlobals(); command = 'tui';
    if (!process.stdin.isTTY || !process.stdout.isTTY || flags.json) throw new CliError('USAGE', 'The TUI needs a terminal on stdin and stdout. Use one-shot commands with --json in scripts.');
    context = await Context.open(flags);
    const { startTui } = await import('./tui/app.js'); await startTui(context);
  });
  try {
    if (argv.slice(2).includes('--schema')) { process.stdout.write(json(schema(), true) + '\n'); return; }
    if (argv.length === 2) {
      if (process.stdin.isTTY && process.stdout.isTTY) argv = [...argv, 'tui'];
      else { program.outputHelp(); return; }
    }
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof CommanderError && ['commander.helpDisplayed', 'commander.version', 'commander.help'].includes(error.code)) return;
    if (error instanceof CommanderError) error = new CliError('USAGE', safe(error.message));
    const info = errorInfo(error); process.exitCode = info.exitCode;
    const result = { schemaVersion: 1, ok: false, command, error: { code: info.code, message: info.message, details: info.details } };
    const wantsJson = flags.json || argv.includes('--json');
    (wantsJson ? process.stdout : process.stderr).write((wantsJson ? json(result) : `${info.code}: ${info.message}${Object.keys(info.details).length ? '\n' + json(info.details, true) : ''}`) + '\n');
  } finally { context?.close(); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
}
await main();
