import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from '../context.js';
import type { CommandSpec, Input } from '../commands.js';
import { CliError, json } from '../values.js';

export async function spawnCommand(ctx: Context, spec: CommandSpec, input: Input, signal: AbortSignal, interactive = false, review?: { preview: Input; id: string }): Promise<Input> {
  signal.throwIfAborted();
  const argv = ['--', fileURLToPath(new URL('../bin.js', import.meta.url)), '--json', '--network', ctx.network, '--config-dir', ctx.store.directory, '--timeout', String(ctx.timeout), '--confirmations', String(ctx.confirmations)];
  if (review) argv.push('--from', String((review.preview.transaction as Input).from), '--send', '--yes', '--id', review.id, '--expect-hash', String(review.preview.reviewHash));
  for (const [flag, value] of [
    ['--wallet', ctx.flags.wallet ?? ctx.config.wallet], ['--key-env-file', ctx.flags.keyEnvFile], ['--rpc', ctx.flags.rpc],
    ['--max-value', ctx.flags.maxValue], ['--max-gas', ctx.flags.maxGas], ['--dao', ctx.flags.dao ?? ctx.config.daos[ctx.network]],
    ['--password-file', ctx.flags.passwordFile], ['--new-password-file', ctx.flags.newPasswordFile], ['--key-file', ctx.flags.keyFile],
  ] as const) if (value) argv.push(flag, value);
  if (ctx.flags.allowWeakKeystore) argv.push('--allow-weak-keystore');
  const directory = await mkdtemp(join(tmpdir(), 'daoships-command-'));
  try {
    const file = join(directory, 'input.json');
    await writeFile(file, json(input), { flag: 'wx', mode: 0o600 });
    argv.push('run', spec.path, '@' + file);
    if (interactive) {
      // Finish Ink's current read handler before its child takes ownership of fd 0.
      await new Promise<void>(resolve => setImmediate(resolve));
      process.stdin.pause();
    }
    signal.throwIfAborted();
    const env = { ...process.env };
    if (!['wallet import', 'wallet migrate'].includes(spec.path)) {
      delete env.DAOSHIPS_PRIVATE_KEY;
      for (const profile of Object.values(ctx.config.wallets)) if ('env' in profile) delete env[profile.env];
    }
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, argv, { stdio: [interactive ? 'inherit' : 'ignore', 'pipe', interactive ? 'inherit' : 'ignore'], env });
      let output = '', overflow = false, killTimer: ReturnType<typeof setTimeout> | undefined;
      const abort = () => { child.kill('SIGINT'); killTimer ??= setTimeout(() => child.kill('SIGKILL'), 5000); };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      child.stdout!.setEncoding('utf8');
      child.stdout!.on('data', (data: string) => {
        if (overflow) return;
        if (Buffer.byteLength(output) + Buffer.byteLength(data) > 4_194_304) { overflow = true; output = ''; abort(); } else output += data;
      });
      child.on('error', () => reject(new CliError('CHILD_FAILED', 'Could not start the command process.', {}, 1)));
      child.on('close', code => {
        clearTimeout(killTimer); signal.removeEventListener('abort', abort);
        try {
          if (signal.aborted) throw new CliError('ABORTED', 'Command cancelled. Check Journal for any submitted transaction.', review ? { id: review.id } : {}, 130);
          if (overflow) throw Error();
          const result = JSON.parse(output) as Input;
          if (result.schemaVersion !== 1 || typeof result.ok !== 'boolean') throw Error();
          if (!result.ok) { const error = result.error as Input; throw new CliError(String(error.code), String(error.message), error.details as Input, code && code > 0 ? code : 1); }
          if (code !== 0) throw Error();
          resolve(result.data as Input);
        } catch (error) {
          reject(error instanceof CliError ? error : new CliError(review ? 'TX_PENDING' : 'CHILD_FAILED', review ? 'The command stopped without a verified result. Check Journal before retrying.' : 'The command stopped without a verified result. Reload your wallet list before retrying.', review ? { id: review.id } : {}, review ? 4 : 1));
        }
      });
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
export function spawnAction(ctx: Context, spec: CommandSpec, input: Input, preview: Input, id: string, signal: AbortSignal, interactive = false): Promise<Input> {
  return spawnCommand(ctx, spec, input, signal, interactive, { preview, id });
}
