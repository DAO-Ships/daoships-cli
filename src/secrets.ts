import password from '@inquirer/password';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { CliError } from './values.js';

/** Open first, inspect the descriptor, and bound the actual read (including growing files). */
export async function readSecretFile(path: string, maxBytes = 4096, privateMode = true): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maxBytes || info.nlink !== 1) throw new CliError('SECRET_FILE', 'Secret input must be a regular file without hard links, within its size limit.');
    if (privateMode && process.platform !== 'win32' && ((info.mode & 0o077) || (process.getuid && info.uid !== process.getuid()))) {
      throw new CliError('SECRET_FILE', 'Secret files must belong to you and have owner-only permissions (chmod 600).');
    }
    const bytes = Buffer.alloc(maxBytes + 1);
    try {
      let size = 0;
      while (size < bytes.length) { const read = await file.read(bytes, size, bytes.length - size, null); if (!read.bytesRead) break; size += read.bytesRead; }
      if (size > maxBytes) throw new CliError('SECRET_FILE', 'Secret input exceeds its size limit.');
      return bytes.subarray(0, size).toString('utf8');
    } finally { bytes.fill(0); }
  } finally { await file.close(); }
}

export async function promptSecret(message: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw new CliError('SECRET_REQUIRED', 'A terminal is required for secret entry. Agents can use --password-file and --key-file; never put secrets in command arguments.', {}, 3);
  try { return await password({ message, mask: true, toggleMask: false }, { input: process.stdin, output: process.stderr, clearPromptOnDone: true, signal }); }
  catch { throw new CliError('ABORTED', 'Secret entry cancelled.', {}, 130); }
}

export async function readPassword(file: string | undefined, signal: AbortSignal, fresh = false): Promise<string> {
  signal.throwIfAborted();
  const value = file ? (await readSecretFile(file)).replace(/\r?\n$/, '') : await promptSecret(fresh ? 'New keystore password (12+ characters):' : 'Keystore password:', signal);
  if (!value || Buffer.byteLength(value) > 1024 || /[\r\n\0]/.test(value)) throw new CliError('PASSWORD', 'Passwords must contain 1–1024 UTF-8 bytes without line breaks or NUL.');
  if (fresh) {
    if ([...value].length < 12) throw new CliError('PASSWORD', 'Use at least 12 characters for the keystore password.');
    if (!file && value !== await promptSecret('Repeat new password:', signal)) throw new CliError('PASSWORD', 'Passwords did not match.');
  }
  signal.throwIfAborted();
  return value;
}
