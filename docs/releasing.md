# Releasing the CLI

Publication runs through GitHub tags in `DAO-Ships/daoships-cli`, using `.github/workflows/release.yml`. Do not publish from a workstation or request an npm login for routine releases.

## Initial trusted publisher setup

In the npm settings for `@daoships/cli`, add a GitHub Actions trusted publisher with organization `DAO-Ships`, repository `daoships-cli`, workflow filename `release.yml`, environment `npm`, and permission to run `npm publish`. Configure the repository environment `npm` to allow version tags, then set repository variable `NPM_TRUSTED_PUBLISHING_ENABLED=true`. No npm token is needed. The SDK has its own independent trusted publisher.

See [npm's trusted publisher instructions](https://docs.npmjs.com/trusted-publishers/).

## Release sequence

1. Publish any new SDK dependency through its own acceptance checks and version tag first. Confirm the exact dependency is installable from npm.
2. Update the CLI version, lockfile, changelog and SDK dependency together. Run `npm run check` and `node scripts/package-test.mjs --registry-install`.
3. Commit and push the release to `main`. Require successful CLI validation on that exact commit on Node 22, 24 and 26.
4. Create an annotated tag matching `package.json` exactly, for example `git tag -a v0.1.0-alpha.1 -m 'Release CLI 0.1.0-alpha.1'`, then push that tag.
5. Monitor the release workflow. Its unprivileged job validates metadata, tests, audits dependencies and installs the packed CLI in a clean consumer. A separate OIDC job verifies the archive checksum and publishes those tested bytes with provenance. Prereleases use their named channel (`alpha`); stable releases use `latest`.
6. Verify the npm version, integrity, provenance, dist-tag and a fresh installation. Record the workflow URL and source commit.

If authentication fails, correct the trusted publisher settings and rerun the failed workflow on the same tag. Never move an existing release tag or substitute a locally built archive. If the version already exists, verify its provenance and integrity before taking further action; published versions cannot be overwritten.
