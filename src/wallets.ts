import { open } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import type { Wallet } from 'quais';
import type { Context } from './context.js';
import { CliError } from './values.js';
import { decryptWallet, encryptWallet, generateWallet, keystoreKey, privateWallet, validateKeystore, walletName, type Keystore } from './keystore.js';
import { promptSecret, readSecretFile } from './secrets.js';

function unused(ctx: Context, name: string): void {
  walletName(name);
  if (Object.hasOwn(ctx.config.wallets, name) || ctx.store.get(keystoreKey(name))) throw new CliError('WALLET_EXISTS', 'That wallet name is already in use. Choose another name.');
}
function stored(ctx: Context, name: string): Keystore {
  walletName(name);
  const profile = Object.hasOwn(ctx.config.wallets, name) ? ctx.config.wallets[name] : undefined;
  const key = ctx.store.get<Keystore>(keystoreKey(name));
  if (!profile || profile.kind !== 'keystore' || !key || key.version !== 1 || key.address.toLowerCase() !== profile.address.toLowerCase()) throw new CliError('KEYSTORE', 'Unknown or inconsistent keystore wallet.', {}, 3);
  return key;
}
async function persist(ctx: Context, name: string, wallet: Wallet, migration = false) {
  const key = await encryptWallet(wallet, await ctx.password(true), ctx.signal);
  ctx.config.wallets[name] = { kind: 'keystore', address: wallet.address };
  ctx.config.wallet = name; ctx.config.address = wallet.address;
  ctx.save([{ key: keystoreKey(name), previous: null, next: key }]);
  return { name, address: wallet.address, kind: 'keystore', active: true, ...(migration ? { next: 'The plaintext source was not deleted. Remove it once you have verified your encrypted backup.' } : {}) };
}
export async function createWallet(ctx: Context, name: string) {
  unused(ctx, name);
  return persist(ctx, name, await generateWallet(ctx.signal));
}
export async function importWallet(ctx: Context, name: string, env?: string) {
  unused(ctx, name);
  if (env && ctx.flags.keyFile) throw new CliError('USAGE', 'Choose either an environment variable or --key-file.');
  const raw = env ? await ctx.key(env) : ctx.flags.keyFile ? (await readSecretFile(ctx.flags.keyFile, 256)).replace(/\r?\n$/, '') : await promptSecret('Private key (hidden):', ctx.signal);
  return persist(ctx, name, privateWallet(raw));
}
export async function migrateWallet(ctx: Context, name: string) {
  walletName(name);
  const profile = Object.hasOwn(ctx.config.wallets, name) ? ctx.config.wallets[name] : undefined;
  if (!profile || profile.kind === 'keystore') throw new CliError('USAGE', 'Choose an existing environment wallet from wallet list.');
  const wallet = privateWallet(await ctx.key(profile.env));
  if (wallet.address.toLowerCase() !== profile.address.toLowerCase()) throw new CliError('SIGNER_MISMATCH', 'The environment key no longer matches this wallet profile.', {}, 3);
  return persist(ctx, name, wallet, true);
}
export async function importKeystore(ctx: Context, name: string, file: string) {
  unused(ctx, name);
  const raw = validateKeystore(await readSecretFile(file, 65_536, false), ctx.flags.allowWeakKeystore);
  const wallet = await decryptWallet(raw, await ctx.password(), ctx.signal, ctx.flags.allowWeakKeystore);
  const key = await encryptWallet(wallet, await ctx.password(true, true), ctx.signal);
  ctx.config.wallets[name] = { kind: 'keystore', address: wallet.address };
  ctx.config.wallet = name; ctx.config.address = wallet.address;
  ctx.save([{ key: keystoreKey(name), previous: null, next: key }]);
  return { name, address: wallet.address, kind: 'keystore', active: true };
}
export async function exportKeystore(ctx: Context, name: string, path: string) {
  const key = stored(ctx, name); validateKeystore(key.json);
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(key.json + '\n'); await file.sync(); } finally { await file.close(); }
  return { name, address: key.address, file: path, encrypted: true };
}
export async function verifyWallet(ctx: Context, name: string) {
  const key = stored(ctx, name), wallet = await decryptWallet(key.json, await ctx.password(), ctx.signal);
  if (wallet.address.toLowerCase() !== key.address.toLowerCase()) throw new CliError('SIGNER_MISMATCH', 'Keystore address differs from the public wallet profile.', {}, 3);
  return { name, address: wallet.address, verified: true };
}
export async function changePassword(ctx: Context, name: string) {
  const key = stored(ctx, name), wallet = await decryptWallet(key.json, await ctx.password(), ctx.signal);
  if (wallet.address.toLowerCase() !== key.address.toLowerCase()) throw new CliError('SIGNER_MISMATCH', 'Keystore address differs from the public wallet profile.', {}, 3);
  const next = await encryptWallet(wallet, await ctx.password(true, true), ctx.signal);
  ctx.signal.throwIfAborted();
  if (!ctx.store.swapDocument(keystoreKey(name), key, next)) throw new CliError('CONFIG_CHANGED', 'The keystore changed in another process. Reload and retry.', {}, 3);
  return { name, address: wallet.address, changed: true, next: 'Export a new backup. Existing backups retain their old password.' };
}
export async function removeWallet(ctx: Context, name: string) {
  walletName(name);
  if (!Object.hasOwn(ctx.config.wallets, name)) throw new CliError('USAGE', 'Unknown wallet.');
  if (!ctx.flags.yes) {
    if (!process.stdin.isTTY || !process.stderr.isTTY) throw new CliError('CONSENT_REQUIRED', 'wallet remove deletes the local keystore. Export a backup, then use --yes to confirm removal.', {}, 3);
    const prompt = createInterface({ input: process.stdin, output: process.stderr });
    try { if (await prompt.question(`Delete the local keystore? Type ${name} to confirm: `, { signal: ctx.signal }) !== name) throw new CliError('DECLINED', 'Wallet removal declined.', {}, 5); }
    finally { prompt.close(); }
  }
  const previous = ctx.store.get(keystoreKey(name));
  delete ctx.config.wallets[name]; if (ctx.config.wallet === name) delete ctx.config.wallet;
  ctx.save([{ key: keystoreKey(name), previous, next: null }]);
  return { removed: name, watchAddress: ctx.config.address, next: 'Previously exported backups are unaffected.' };
}
