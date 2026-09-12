import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { validateReleaseMetadata } from '../scripts/check-release.mjs';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const licenseText = await readFile(new URL('../LICENSE', import.meta.url), 'utf8');
const context = { licenseText, ref: `refs/tags/v${manifest.version}`, repository: 'DAO-Ships/daoships-cli' };

test('release metadata binds the package, tag, repository and npm channel', () => {
  assert.deepEqual(validateReleaseMetadata(manifest, context), { version: manifest.version, distTag: 'alpha' });
  const stable = { ...manifest, version: '1.0.0' };
  assert.equal(validateReleaseMetadata(stable, { ...context, ref: 'refs/tags/v1.0.0' }).distTag, 'latest');
  for (const change of [{ name: '@other/cli' }, { private: true }, { license: 'UNLICENSED' },
    { repository: { type: 'git', url: 'git+https://github.com/other/repo.git' } },
    { publishConfig: { access: 'public', registry: 'https://other.example/' } }]) {
    assert.throws(() => validateReleaseMetadata({ ...manifest, ...change }, context));
  }
  for (const version of ['1.0.0-latest', '1.0.0-alpha.01', '1.0.0-x', '1.0.0-v1', '1.0.0+build']) {
    assert.throws(() => validateReleaseMetadata({ ...manifest, version }, { ...context, ref: `refs/tags/v${version}` }));
  }
  for (const ref of ['refs/heads/main', 'refs/tags/v0.0.0', undefined]) {
    if (ref !== undefined) assert.throws(() => validateReleaseMetadata(manifest, { ...context, ref }));
  }
  assert.throws(() => validateReleaseMetadata(manifest, { ...context, licenseText: '' }));
});

test('publication script refuses workstation execution before invoking npm', () => {
  const result = spawnSync(process.execPath, ['--', new URL('../scripts/publish-release.mjs', import.meta.url).pathname], {
    encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'false' }, timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /configured npm trusted-publisher workflow/);
});
