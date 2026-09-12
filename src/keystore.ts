import { Wallet, encryptKeystoreJson, decryptKeystoreJson, randomBytes, hexlify } from 'quais';
import { isCyprus1Address } from '@daoships/sdk';
import { CliError, parseJson } from './values.js';

export interface Keystore { version: 1; address: string; json: string }
export const keystoreKey = (name: string) => `keystore:${walletName(name)}`;
export function walletName(name: string): string {
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/.test(name) || ['constructor', 'prototype', '__proto__'].includes(name)) throw new CliError('USAGE', 'Use a wallet name of 1–40 letters, digits, underscores or hyphens, starting with a letter.');
  return name;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CliError('KEYSTORE', 'Invalid V3 keystore structure.');
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    const lower = key.toLowerCase();
    if (Object.hasOwn(result, lower)) throw new CliError('KEYSTORE', 'Ambiguous keystore fields.');
    result[lower] = item;
  }
  return result;
}
/** Validate the exact fields handed to quais before any expensive or secret operation. */
export function validateKeystore(raw: string, allowWeak = false): string {
  if (Buffer.byteLength(raw) > 65_536) throw new CliError('KEYSTORE', 'Keystores must be at most 64 KiB.');
  const root = record(parseJson(raw)), crypto = record(root.crypto), params = record(crypto.kdfparams), cipher = record(crypto.cipherparams);
  const hex = (value: unknown, min: number, max = min) => typeof value === 'string' && value.length >= min * 2 && value.length <= max * 2 && /^(?:[a-f0-9]{2})+$/i.test(value);
  if (root.version !== 3 || !hex(root.address, 20) || crypto.cipher !== 'aes-128-ctr' || !hex(crypto.ciphertext, 32) || !hex(crypto.mac, 32) || !hex(cipher.iv, 16) || !hex(params.salt, 16, 64) || params.dklen !== 32) throw new CliError('KEYSTORE', 'Unsupported or malformed V3 keystore.');
  const positive = (field: string) => { const n = params[field]; if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1) throw new CliError('KEYSTORE', 'Invalid keystore KDF parameters.'); return n; };
  const kdf = typeof crypto.kdf === 'string' ? crypto.kdf.toLowerCase() : '';
  if (kdf === 'scrypt') {
    const n = positive('n'), r = positive('r'), p = positive('p');
    // At most 256 MiB of scrypt workspace and four times the default work.
    if (!Number.isInteger(Math.log2(n)) || n > 262_144 || r > 16 || p > 4 || n * r > 2_097_152 || n * r * p > 4_194_304) throw new CliError('KEYSTORE', 'Keystore KDF exceeds the accepted memory or CPU budget.');
    if (!allowWeak && (n < 131_072 || r < 8)) throw new CliError('WEAK_KEYSTORE', 'Weak keystore KDF. Import with --allow-weak-keystore to re-encrypt it at the current strength.', {}, 3);
  } else if (kdf === 'pbkdf2') {
    const c = positive('c');
    if (!['hmac-sha256', 'hmac-sha512'].includes(String(params.prf)) || c > 2_000_000) throw new CliError('KEYSTORE', 'Unsupported or excessive PBKDF2 parameters.');
    if (!allowWeak && c < 600_000) throw new CliError('WEAK_KEYSTORE', 'Weak keystore KDF. Import with --allow-weak-keystore to re-encrypt it at the current strength.', {}, 3);
  } else throw new CliError('KEYSTORE', 'Unsupported keystore KDF.');
  // Discard extensions, including mnemonic metadata. Only the account key is imported.
  return JSON.stringify({ version: 3, address: root.address, crypto: { cipher: crypto.cipher, ciphertext: crypto.ciphertext, mac: crypto.mac, cipherparams: { iv: cipher.iv }, kdf, kdfparams: params } });
}
export function privateWallet(key: string): Wallet {
  if (!/^0x[\da-f]{64}$/i.test(key)) throw new CliError('PRIVATE_KEY', 'A private key must be 32 bytes of hex with a 0x prefix.');
  let wallet: Wallet;
  try { wallet = new Wallet(key); } catch { throw new CliError('PRIVATE_KEY', 'Invalid private key.'); }
  if (!isCyprus1Address(wallet.address)) throw new CliError('PRIVATE_KEY', 'The key must belong to a Cyprus-1 Quai ledger account.');
  return wallet;
}
export async function generateWallet(signal: AbortSignal): Promise<Wallet> {
  for (let i = 0; i < 10_000; i++) {
    signal.throwIfAborted();
    const bytes = randomBytes(32);
    try { const wallet = new Wallet(hexlify(bytes)); if (isCyprus1Address(wallet.address)) return wallet; } finally { bytes.fill(0); }
    if (i % 16 === 0) await new Promise<void>(resolve => setImmediate(resolve));
  }
  throw new CliError('KEY_GENERATION', 'Could not generate a Cyprus-1 account within the attempt limit. Retry.');
}
export async function encryptWallet(wallet: Wallet, password: string, signal: AbortSignal): Promise<Keystore> {
  signal.throwIfAborted();
  const json = await encryptKeystoreJson({ address: wallet.address, privateKey: wallet.privateKey }, password, { scrypt: { N: 131_072, r: 8, p: 1 }, progressCallback: () => { signal.throwIfAborted(); } });
  signal.throwIfAborted();
  return { version: 1, address: wallet.address, json };
}
export async function decryptWallet(raw: string, password: string, signal: AbortSignal, allowWeak = false): Promise<Wallet> {
  const normalized = validateKeystore(raw, allowWeak);
  signal.throwIfAborted();
  try {
    const account = await decryptKeystoreJson(normalized, password, () => { signal.throwIfAborted(); });
    signal.throwIfAborted();
    return privateWallet(account.privateKey);
  } catch {
    signal.throwIfAborted();
    throw new CliError('UNLOCK_FAILED', 'Could not unlock the keystore. Check its password and integrity.', {}, 3);
  }
}
