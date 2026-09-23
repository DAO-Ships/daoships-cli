import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveReleaseArchive } from './pack-release.mjs';
const exec = promisify(execFile), root = fileURLToPath(new URL('../', import.meta.url)), directory = await mkdtemp(join(tmpdir(), 'daoships-cli-package-'));
try {
  const { stdout } = await exec('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', directory], { cwd: root, maxBuffer: 4 * 1024 * 1024 });
  const [pack] = JSON.parse(stdout), paths = pack.files.map(f => f.path);
  for (const required of ['dist/bin.js', 'dist/tui/app.js', 'dist/rpc.js', 'dist/keystore.js', 'dist/secrets.js', 'dist/wallets.js', 'dist/tui/child.js', 'CHANGELOG.md', 'README.md', 'LICENSE', 'docs/commands.json']) assert.ok(paths.includes(required), required);
  assert.equal(paths.some(p => /(^|\/)(\.env[^/]*|test|src|scripts|node_modules)(\/|$)|\.sqlite|\.tgz$/.test(p)), false);
  const consumer = join(directory, 'consumer'); await mkdir(consumer);
  await exec('tar', ['-xzf', join(directory, pack.filename), '-C', consumer]);
  const installed = join(consumer, 'package'); await symlink(join(root, 'node_modules'), join(installed, 'node_modules'), 'dir');
  if (process.argv.includes('--registry-install')) {
    await rm(join(installed, 'node_modules'));
    await exec('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org/'], { cwd: installed, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
  }
  const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  assert.equal(manifest.dependencies['@daoships/sdk'], '0.1.0-alpha.4'); assert.equal(manifest.bin.daoships, manifest.bin.ds);
  assert.ok((await stat(join(installed, manifest.bin.daoships))).mode & 0o111);
  for (const args of [['--version'], ['--schema'], ['--json', 'network', 'list'], ['--json', 'contract', 'methods', 'OnboarderNavigator']]) {
    const result = await exec(process.execPath, [join(installed, manifest.bin.daoships), '--config-dir', join(directory, 'state'), ...args], { cwd: directory, maxBuffer: 4 * 1024 * 1024 });
    if (args[0] === '--version') assert.equal(result.stdout.trim(), manifest.version);
    else { const parsed = JSON.parse(result.stdout); assert.ok(parsed.schemaVersion === 1); }
  }
  console.log(`Package verified: ${pack.filename}, ${paths.length} files, ${(pack.size / 1024).toFixed(1)} KiB compressed. Isolated bin, schema, and SDK methods passed.`);
  if (process.argv.includes('--save-release')) {
    assert.ok(process.argv.includes('--registry-install'), 'Release archive requires a clean registry consumer.');
    const sourceManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    await saveReleaseArchive(join(directory, pack.filename), pack, sourceManifest.version);
  }
} finally { await rm(directory, { recursive: true, force: true }); }
