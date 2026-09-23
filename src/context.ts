import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { parseEnv } from 'node:util';
import { Wallet, Shard } from 'quais';
import { DaoShipsChain, type DaoShipsProvider, DaoShipsIndexer, DAOSHIPS_SUPABASE, DaoShipsData, address, isCyprus1Address } from '@daoships/sdk';
import { EndpointProvider } from './rpc.js';
import { Store } from './store.js';
import { CliError, amount, integer, json, parseJson } from './values.js';
import { decryptWallet, keystoreKey, walletName, type Keystore } from './keystore.js';
import { readPassword, readSecretFile } from './secrets.js';

export const NETWORKS = {
  orchard: { chainId: 15000, schema: 'testnet', rpc: 'https://orchard.rpc.quai.network/cyprus1', label: 'Orchard' },
  mainnet: { chainId: 9, schema: 'mainnet', rpc: 'https://rpc.quai.network/cyprus1', label: 'Mainnet' },
} as const;
export type Network = keyof typeof NETWORKS;
export type WalletProfile = { address: string; kind: 'keystore' } | { address: string; env: string; kind?: 'environment' };
export interface Config {
  version: 1; network: Network; daos: Partial<Record<Network, string>>; address?: string;
  wallet?: string; wallets: Record<string, WalletProfile>;
  aliases: Record<string, string>;
}
export interface Flags {
  network?: string; rpc?: string; configDir?: string; from?: string; dao?: string;
  json?: boolean; send?: boolean; yes?: boolean; id?: string; wallet?: string; keyEnvFile?: string;
  timeout?: string | number; confirmations?: string | number; maxValue?: string; maxGas?: string;
  limit?: string | number; offset?: string | number; expectHash?: string;
  passwordFile?: string; newPasswordFile?: string; keyFile?: string; allowWeakKeystore?: boolean;
}
const initial = (): Config => ({ version: 1, network: 'orchard', daos: {}, wallets: {}, aliases: {} });
function validateConfig(value: Config): Config {
  try {
    const config = parseJson(json(value)) as Config;
    if (config.version !== 1 || !['orchard', 'mainnet'].includes(config.network) || Object.keys(config).some(k => !['version', 'network', 'daos', 'wallets', 'aliases', 'wallet', 'address'].includes(k))) throw Error();
    for (const map of [config.daos, config.wallets, config.aliases]) if (!map || typeof map !== 'object' || Array.isArray(map) || Object.keys(map).length > 1000) throw Error();
    for (const [key, address] of Object.entries(config.daos)) { networkName(key); checkedAddress(address); }
    for (const address of Object.values(config.aliases)) checkedAddress(address);
    if (config.address !== undefined) checkedAddress(config.address);
    if (config.wallet !== undefined) { walletName(config.wallet); if (!Object.hasOwn(config.wallets, config.wallet)) throw Error(); }
    for (const [name, profile] of Object.entries(config.wallets)) {
      walletName(name); checkedAddress(profile.address);
      if (Object.keys(profile).some(k => !['address', 'env', 'kind'].includes(k))) throw Error();
      if (profile.kind === 'keystore' && Object.hasOwn(profile, 'env')) throw Error();
      if (profile.kind !== 'keystore' && (!('env' in profile) || !/^[A-Z][A-Z0-9_]{0,99}$/.test(profile.env) || (profile.kind && profile.kind !== 'environment'))) throw Error();
    }
    return config;
  } catch { throw new CliError('CONFIG', 'Invalid public configuration. Restore a known-good state database or use a separate --config-dir.'); }
}
export function networkName(value: string): Network {
  if (value === 'testnet') return 'orchard';
  if (value !== 'orchard' && value !== 'mainnet') throw new CliError('USAGE', 'Choose orchard or mainnet.');
  return value;
}
export function checkedAddress(value: string): `0x${string}` {
  const result = address(value);
  if (!isCyprus1Address(result)) throw new CliError('USAGE', 'DAOShips requires a Cyprus-1 Quai ledger address.');
  return result;
}
export class Context {
  private closed = false;
  private transport?: DaoShipsProvider;
  readonly network: Network;
  readonly chainId: number;
  readonly timeout: number;
  readonly confirmations: number;
  readonly abort = new AbortController();
  readonly indexer: DaoShipsIndexer;
  readonly data: DaoShipsData;
  private savedConfig: Config | null;
  constructor(readonly store: Store, readonly config: Config, readonly flags: Flags = {}) {
    this.savedConfig = store.get<Config>('config');
    this.network = networkName(flags.network ?? config.network);
    this.chainId = NETWORKS[this.network].chainId;
    this.timeout = integer(flags.timeout ?? 30_000, 'timeout', 300_000);
    this.confirmations = integer(flags.confirmations ?? 2, 'confirmations', 100);
    if (!this.timeout || !this.confirmations) throw new CliError('USAGE', 'Timeout and confirmations must be positive.');
    if (flags.maxValue !== undefined) amount(flags.maxValue);
    if (flags.maxGas !== undefined && amount(flags.maxGas) === 0n) throw new CliError('USAGE', 'Maximum gas must be positive.');
    if (flags.expectHash !== undefined && !/^0x[\da-f]{64}$/i.test(flags.expectHash)) throw new CliError('USAGE', 'Review hash must be 32 bytes of hex.');
    this.indexer = new DaoShipsIndexer({ ...DAOSHIPS_SUPABASE, key: DAOSHIPS_SUPABASE.publishableKey,
      schema: NETWORKS[this.network].schema, timeoutMs: this.timeout });
    this.data = new DaoShipsData(this.indexer);
  }
  static async open(flags: Flags = {}): Promise<Context> {
    const directory = resolve(flags.configDir ?? process.env.DAOSHIPS_CONFIG_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'daoships'));
    const store = await Store.open(directory);
    try { return new Context(store, validateConfig(store.get<Config>('config') ?? initial()), { ...flags }); } catch (error) { store.close(); throw error; }
  }
  get provider(): DaoShipsProvider {
    if (!this.transport) {
      const rpc = new URL(this.flags.rpc ?? NETWORKS[this.network].rpc);
      if (!['http:', 'https:'].includes(rpc.protocol) || rpc.username || rpc.password || rpc.hash) throw new CliError('USAGE', 'RPC must be an HTTP(S) URL without credentials or fragments.');
      this.transport = new EndpointProvider(rpc.href, this.chainId, this.timeout);
    }
    return this.transport;
  }
  get chain(): DaoShipsChain { return new DaoShipsChain(this.provider, this.chainId, { timeoutMs: this.timeout }); }
  get signal(): AbortSignal { return this.abort.signal; }
  resolve(value: string): `0x${string}` { return checkedAddress(Object.hasOwn(this.config.aliases, value) ? this.config.aliases[value]! : value); }
  dao(value?: string): `0x${string}` {
    const target = value || this.flags.dao || this.config.daos[this.network];
    if (!target) throw new CliError('CONFIG', 'Select a DAO with “dao use <address>”, or pass --dao.');
    return this.resolve(target);
  }
  from(): `0x${string}` {
    const wallet = this.flags.wallet ?? this.config.wallet;
    if (wallet && !Object.hasOwn(this.config.wallets, wallet)) throw new CliError('CONFIG', 'Unknown wallet profile. Use wallet list.');
    const selected = wallet && Object.hasOwn(this.config.wallets, wallet) ? this.config.wallets[wallet]?.address : undefined;
    const identity = this.flags.from ?? selected ?? this.config.address;
    if (!identity) throw new CliError('CONFIG', 'Set a public address with “wallet watch <address>”, create/import a wallet, or pass --from.');
    return this.resolve(identity);
  }
  save(changes: { key: string; previous: unknown; next: unknown }[] = []): void {
    this.signal.throwIfAborted();
    validateConfig(this.config);
    if (!this.store.changeDocuments([{ key: 'config', previous: this.savedConfig, next: this.config }, ...changes])) {
      const fresh = validateConfig(this.store.get<Config>('config') ?? initial());
      for (const key of Object.keys(this.config)) delete (this.config as unknown as Record<string, unknown>)[key];
      Object.assign(this.config, fresh); this.savedConfig = this.store.get<Config>('config');
      throw new CliError('CONFIG_CHANGED', 'The wallet or settings changed in another process. Reload and retry.', {}, 3);
    }
    this.savedConfig = structuredClone(this.config);
  }
  page(): { limit: number; offset: number; signal: AbortSignal } {
    const limit = integer(this.flags.limit ?? 50, 'limit', 1000), offset = integer(this.flags.offset ?? 0, 'offset');
    if (!limit) throw new CliError('USAGE', 'Limit must be positive.');
    return { limit, offset, signal: this.signal };
  }
  async rpc<T>(work: () => Promise<T>): Promise<T> {
    const deadline = performance.now() + this.timeout;
    let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
    try {
      this.signal.throwIfAborted();
      const result = await Promise.race([Promise.resolve().then(() => { this.signal.throwIfAborted(); return work(); }), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new CliError('TIMEOUT', 'RPC request timed out.', {}, 1)), this.timeout);
        abort = () => reject(new CliError('ABORTED', 'Cancelled.', {}, 130)); this.signal.addEventListener('abort', abort, { once: true });
      })]);
      if (performance.now() >= deadline) throw new CliError('TIMEOUT', 'RPC request exceeded its deadline.', {}, 1);
      return result;
    } finally { clearTimeout(timer); if (abort) this.signal.removeEventListener('abort', abort); }
  }
  async head() { await this.assertNetwork(); const block = await this.rpc(() => this.provider.getBlock(Shard.Cyprus1, 'latest')); return { number: block?.woHeader.number, hash: block?.hash, timestamp: block?.woHeader.timestamp }; }
  /** The block at a height. quais (through 1.0.0-alpha.57) throws BAD_DATA from getBlock() for older mainnet
   * blocks, whose totalEntropy the node returns as null; read those raw, keeping only the fields checks use. */
  async block(number: number): Promise<{ hash: string; woHeader: { number: number } } | null> {
    try { return await this.rpc(() => this.provider.getBlock(Shard.Cyprus1, number)); }
    catch (cause) {
      if ((cause as { code?: unknown } | null)?.code !== 'BAD_DATA') throw cause;
      const raw: unknown = await this.rpc(() => this.provider.send('quai_getBlockByNumber', [`0x${number.toString(16)}`, false], Shard.Cyprus1));
      if (raw === null) return null;
      const block = raw as { hash?: unknown; woHeader?: { number?: unknown } }, height = block.woHeader?.number;
      if (typeof block.hash !== 'string' || !/^0x[\da-f]{64}$/i.test(block.hash) || typeof height !== 'string' || !/^0x[\da-f]+$/i.test(height) || Number(height) !== number) {
        throw new CliError('INVALID_RESPONSE', 'RPC returned an invalid block.', { number }, 1);
      }
      return { hash: block.hash, woHeader: { number } };
    }
  }
  async assertNetwork(): Promise<void> {
    if ((await this.rpc(() => this.provider.getNetwork())).chainId !== BigInt(this.chainId)) throw new CliError('CHAIN_MISMATCH', 'RPC network differs from the selected network.', {}, 3);
  }
  /** Only explicit wallet import/signing paths read private-key material. */
  async key(envName?: string): Promise<string> {
    const name = this.flags.wallet ?? this.config.wallet;
    if (!envName && name && !Object.hasOwn(this.config.wallets, name)) throw new CliError('CONFIG', 'Unknown wallet profile. Use wallet list.');
    const profile = name ? this.config.wallets[name] : undefined;
    const env = envName ?? (profile && 'env' in profile ? profile.env : undefined) ?? 'DAOSHIPS_PRIVATE_KEY';
    if (!/^[A-Z][A-Z0-9_]{0,99}$/.test(env)) throw new CliError('CONFIG', 'Wallet environment variable name is invalid.');
    const path = this.flags.keyEnvFile ?? resolve('.env');
    let secret = process.env[env];
    if (!secret || this.flags.keyEnvFile) {
      let content = '';
      try { content = await readSecretFile(path, 65_536); } catch (error) { if (this.flags.keyEnvFile || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      secret = process.env[env] ?? parseEnv(content)[env];
    }
    if (!secret || !/^0x[\da-f]{64}$/i.test(secret)) throw new CliError('CONFIG', `Set ${env} in the environment or the selected .env file.`);
    return secret;
  }
  async signer(): Promise<Wallet> {
    const name = this.flags.wallet ?? this.config.wallet;
    const profile = name && Object.hasOwn(this.config.wallets, name) ? this.config.wallets[name] : undefined;
    if (!name || !profile) throw new CliError('CONFIG', 'Select a keystore with wallet use, or pass --wallet.');
    if (profile.kind !== 'keystore') throw new CliError('MIGRATION_REQUIRED', 'This wallet still references a plaintext key. Run wallet migrate <name> first.', {}, 3);
    if (profile.address.toLowerCase() !== this.from().toLowerCase()) throw new CliError('SIGNER_MISMATCH', 'The selected wallet differs from the reviewed sender.', {}, 3);
    const record = this.store.get<Keystore>(keystoreKey(name));
    if (!record || record.version !== 1 || record.address.toLowerCase() !== profile.address.toLowerCase()) throw new CliError('KEYSTORE', 'The selected wallet keystore is missing or inconsistent.', {}, 3);
    const wallet = await decryptWallet(record.json, await this.password(), this.signal);
    if (wallet.address.toLowerCase() !== profile.address.toLowerCase() || wallet.address.toLowerCase() !== this.from().toLowerCase()) throw new CliError('SIGNER_MISMATCH', 'The unlocked wallet differs from the selected sender.', {}, 3);
    return wallet.connect(this.provider);
  }
  password(fresh = false, replacement = false): Promise<string> {
    return readPassword(replacement ? this.flags.newPasswordFile ?? process.env.DAOSHIPS_NEW_PASSWORD_FILE : this.flags.passwordFile ?? process.env.DAOSHIPS_KEYSTORE_PASSWORD_FILE, this.signal, fresh);
  }
  close(): void { if (this.closed) return; this.closed = true; this.abort.abort(); this.transport?.destroy(); this.store.close(); }
}
