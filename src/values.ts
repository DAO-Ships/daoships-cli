import { readFile, open } from 'node:fs/promises';
import { DaoShipsError, decodeRevert } from '@daoships/sdk';
import type { ParamType } from 'quais';

export class CliError extends Error {
  constructor(public code: string, message: string, public details: Record<string, unknown> = {}, public exitCode = 2) { super(message); }
}
export const fail = (message: string): never => { throw new CliError('USAGE', message); };
export const json = (value: unknown, pretty = false): string => JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? item.toString() : item, pretty ? 2 : undefined);
export const safe = (value: unknown): string => String(value ?? '').replace(/[\p{Cc}\p{Cf}]/gu, '');
export const short = (value: unknown, size = 8): string => { const text = safe(value); return text.length > size * 2 + 2 ? `${text.slice(0, size + 2)}…${text.slice(-size)}` : text; };
export const title = (value: string): string => value.replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ').replace(/^./, s => s.toUpperCase());
export function integer(value: unknown, name: string, max = Number.MAX_SAFE_INTEGER): number {
  const parsed = typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) && value.length <= 16 ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) return fail(`${name} must be an exact nonnegative integer at most ${max}.`);
  return parsed;
}
export function amount(value: unknown): bigint {
  if (typeof value === 'bigint' && value >= 0n && value < 1n << 256n) return value;
  if (typeof value === 'number') { if (!Number.isSafeInteger(value)) fail('Pass exact amounts as decimal strings.'); value = String(value); }
  if (typeof value !== 'string' || value.length > 78 || !/^(0|[1-9]\d*)$/.test(value) || BigInt(value) >= 1n << 256n) return fail('Expected a uint256 decimal string in base units.');
  return BigInt(value);
}
export function parseJson(text: string): unknown {
  if (Buffer.byteLength(text) > 2_097_152) return fail('JSON input exceeds 2 MiB.');
  try {
    return JSON.parse(text, (key, value: unknown) => {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) fail('Unsupported JSON property.');
      if (typeof value === 'number' && !Number.isSafeInteger(value)) fail('JSON numbers must be safe integers; use decimal strings for amounts.');
      return value;
    });
  } catch (error) { if (error instanceof CliError) throw error; return fail('Invalid JSON. Use quoted decimal strings for token amounts and other large integers.'); }
}
export async function readJsonInput(input: string): Promise<unknown> {
  if (!input.startsWith('@')) return parseJson(input);
  const handle = await open(input.slice(1), 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 2_097_152) fail('Input must be a regular file of at most 2 MiB.');
    return parseJson(await handle.readFile('utf8'));
  } finally { await handle.close(); }
}
export async function optionalFile(file: string): Promise<string | undefined> {
  try { return await readFile(file, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
export function abiValue(param: ParamType, value: unknown): unknown {
  if (param.baseType === 'array') {
    if (!Array.isArray(value) || value.length > 10_000 || (param.arrayLength !== -1 && value.length !== param.arrayLength)) return fail(`${param.name || param.type} requires an aligned, bounded JSON array.`);
    return value.map(v => abiValue(param.arrayChildren!, v));
  }
  if (param.baseType === 'tuple') {
    const fields = param.components!;
    if (Array.isArray(value)) { const array = value; if (array.length !== fields.length) fail('Tuple length differs from its ABI.'); return fields.map((p, i) => abiValue(p, array[i])); }
    if (!value || typeof value !== 'object') return fail('Tuple input must be an array or named object.');
    return fields.map(p => abiValue(p, (value as Record<string, unknown>)[p.name]));
  }
  if (/^u?int/.test(param.type)) {
    if (typeof value === 'number') { if (!Number.isSafeInteger(value)) fail('Unsafe ABI integer.'); value = String(value); }
    if (typeof value !== 'string' || value.length > 79 || !/^-?(0|[1-9]\d*)$/.test(value)) return fail(`${param.name || param.type} requires an exact decimal integer.`);
    return BigInt(value);
  }
  if (param.type === 'bool') { if (value === 'true') return true; if (value === 'false') return false; }
  return value;
}
export function abiArgs(params: readonly ParamType[], values: unknown): readonly unknown[] {
  if (!Array.isArray(values) || params.length !== values.length) return fail(`Expected ${params.length} ABI arguments in a JSON array.`);
  return params.map((p, i) => abiValue(p, values[i]));
}
export function errorInfo(error: unknown) {
  if (error instanceof Error && (error.name === 'AbortError' || (error as NodeJS.ErrnoException).code === 'ABORT_ERR')) return { code: 'ABORTED', message: 'Cancelled.', details: {}, exitCode: 130 };
  const fs = error as NodeJS.ErrnoException | null;
  if (fs && ['EACCES', 'EPERM', 'ENOENT', 'EEXIST'].includes(fs.code ?? '')) return { code: 'FILE_ERROR', message: fs.code === 'EEXIST' ? 'The output file already exists. Choose a new path.' : fs.code === 'ENOENT' ? 'A requested file or directory does not exist.' : 'The requested file or configuration directory is not writable/readable.', details: {}, exitCode: 2 };
  const code = error instanceof CliError || error instanceof DaoShipsError ? error.code : 'ERROR';
  const message = error instanceof CliError || error instanceof DaoShipsError ? safe(error.message) : 'Operation failed. Check the network connection and inputs.';
  const revert = code === 'CHAIN_ERROR' ? decodeRevert(error, { maxBytes: 4096, maxNodes: 32 }) : null;
  const details: Readonly<Record<string, unknown>> = { ...(error instanceof CliError || error instanceof DaoShipsError ? error.details : {}), ...(revert ? { revert } : {}) };
  const exitCode = error instanceof CliError ? error.exitCode : ['TX_PENDING', 'BROADCAST_ERROR', 'PERSISTENCE_ERROR', 'RECOVERY_BLOCKED'].includes(code) ? 4
    : ['ABORTED'].includes(code) ? 130 : ['INVALID_ARGUMENT'].includes(code) ? 2
    : revert || ['TX_REVERTED', 'ACTION_FAILED', 'PROPOSAL_DEFEATED', 'CHAIN_MISMATCH', 'SIGNER_MISMATCH', 'PLAN_CHANGED', 'PROPOSAL_STATE', 'RECOVERY_CONFLICT'].includes(code) ? 3 : 1;
  return { code, message, details, exitCode };
}
