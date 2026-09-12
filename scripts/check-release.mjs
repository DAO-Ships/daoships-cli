import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

export function validateReleaseMetadata(manifest, { licenseText, ref, repository } = {}) {
  assert.equal(manifest.name, '@daoships/cli', 'Review package name before publication.');
  assert.notEqual(manifest.private, true, 'Remove private:true only when the package is approved for public release.');
  const version = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([a-z][a-z0-9-]*)(?:\.[a-zA-Z0-9-]+)*)?$/.exec(manifest.version);
  assert.ok(version, 'Expected a release version with a named prerelease channel.');
  if (version[4]) for (const part of manifest.version.slice(manifest.version.indexOf('-') + 1).split('.')) {
    assert.ok(!/^0\d+$/.test(part), 'Numeric prerelease identifiers cannot have leading zeroes.');
  }
  assert.ok(version[4] !== 'x' && !/^v(?:\d|x$)/.test(version[4] ?? ''), 'Prerelease channel cannot be an npm semver range.');
  assert.notEqual(version[4], 'latest', 'Reserve the latest channel for stable releases.');
  assert.ok(typeof manifest.license === 'string' && manifest.license.trim() && manifest.license !== 'UNLICENSED', 'Choose an explicit release license.');
  assert.ok(typeof licenseText === 'string' && licenseText.trim().length > 50, 'Include the selected license text.');
  assert.equal(manifest.repository?.type, 'git');
  const match = /^git\+https:\/\/github\.com\/([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)\.git$/.exec(manifest.repository.url);
  assert.ok(match, 'Provide the actual GitHub repository URL.');
  assert.equal(manifest.publishConfig?.access, 'public');
  assert.equal(manifest.publishConfig?.registry, 'https://registry.npmjs.org/');
  if (ref !== undefined) assert.equal(ref, `refs/tags/v${manifest.version}`, 'Release tag must exactly match package version.');
  if (repository !== undefined) assert.equal(match[1].toLowerCase(), repository.toLowerCase(), 'Provenance repository differs from the package metadata.');
  return { version: manifest.version, distTag: version[4] ?? 'latest' };
}

export async function checkRelease(environment = process.env) {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const licenseText = await readFile(new URL('../LICENSE', import.meta.url), 'utf8').catch(() => '');
  const result = validateReleaseMetadata(manifest, { licenseText, ref: environment.GITHUB_REF, repository: environment.GITHUB_REPOSITORY });
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await checkRelease(process.env))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
