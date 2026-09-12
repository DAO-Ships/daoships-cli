# Initial alpha release audit

Release: `@daoships/cli@0.1.0-alpha.0`, 2026-09-11. SDK: published `@daoships/sdk@0.1.0-alpha.2`.

## Completion record

Implementation, audit fixes and publication are complete. The final automated suite passed **57/57 tests on each of Node 22, 24 and 26**, with no failures, cancellations or skips. npm accepted the release, and installation using `@daoships/cli@alpha` succeeded after registry availability. The installed executable reported `0.1.0-alpha.0`, produced valid JSON and exposed the 88-command schema.

The public registry tarball was downloaded and its SHA-512 integrity matched the tested artifact:

```text
sha512-50O3tvUlcx0kw4JOyYvnGtdlULqGmQYpIR4ljIS3e5sfTIn2I6M5WnnYRt/oYRKZzV50b3hL0J1amZ8M6Z7QYw==
```

A follow-up comparison confirmed all 55 packaged files matched the workspace before this post-publication completion record was added. The remaining validation boundaries below describe the limits of the completed audit.

## Coverage

The generated command registry has 88 commands. ABI inventory tests enumerate all 353 functions in 17 SDK contract ABIs, all eight navigator kinds, their constructor fields and method forms. All 25 indexer tables are exposed. Named DAO/proposal/token flows, generic contract access, DAO launches, navigator creation/activation, metadata, allowlists, IPFS and recovery are available from one-shot commands and the TUI palette.

## Findings addressed

- Replaced environment-based signing with encrypted V3 keystores and explicit legacy migration. Added complete wallet lifecycle commands and password-file automation.
- Added KDF cost validation, account-identity verification, bounded secret-file reads, private permissions, link rejection and atomic key/profile persistence.
- Added compare-and-swap for public settings, preventing concurrent processes from silently overwriting updates.
- Corrected TUI terminal ownership during secret entry. The child owns stdin/stderr while Ink is suspended; the parent receives structured results and restores the workspace.
- Preserved explicit network, DAO, sender and wallet settings through child execution. Added saved-wallet choices and visible wallet entries in Settings.
- Preserved failure exit codes and recovery IDs. Added bounded child cancellation, retained journal pagination through other-network records, and validated transaction limits before secret access.
- Applied DAO proposal, vault inner-execution and exact token-event outcome checks to ordinary sends and recovery. A status-1 outer receipt alone cannot turn these failures into success.
- Added ordinary replacement discovery and explicit reconciliation. Repeated native deployment IDs now return a nonzero pending outcome until verified.
- Preserved gas-cap errors through the SDK's generic estimation wrapper, while retaining SDK persistence failures. This was found during the live preflight: 28,000 estimated gas plus the 20% margin correctly exceeded a 30,000 cap without broadcasting.

## Verification

The automated suite runs on Node 22, 24 and 26, covering real encryption, malformed/tampered keystores, permissions, migration, backup/restore/password changes, process contention and death, stale reviews, ambiguous broadcasts, business failures, all ABI forms, local RPC identity/timeout behavior and terminal layouts.

A real POSIX PTY test imports a synthetic key through the TUI, checks password/private-key masking with the reveal shortcut disabled, rejects a wrong password, cancels secret entry, successfully verifies the wallet, resizes and exits. Package checks inspect the actual tarball and run its binaries outside the source directory. A separate clean production-dependency install is checked before publication. npm reported zero known production vulnerabilities during this audit.

Public RPC/indexer reads passed on Orchard (chain 15000) and mainnet (chain 9). One zero-value Orchard self-transfer through an encrypted wallet confirmed at block **7782615**, transaction `0x0027001b6a762acd83eaf2dcaec6ee9d30526c425746d502225e0bafc68982a4`. Its 40,000-gas ceiling was enforced; journal recovery returned mined, and invoking the same operation ID again returned the existing hash with `changed:false`. The temporary encrypted wallet and password file were removed after verification.

## Remaining boundaries

Full ABI access is established by inventory and encoding tests; every privileged mutation has not been repeated on live contracts through this CLI. Mainnet validation was read-only. Uncommon methods use ABI-derived forms and JSON detail views. Indexer results are discovery data, and can lag chain state. Recovery coordination is local to a shared config directory. A future chain reorganization remains possible after the selected confirmation depth. See [security boundaries](security.md) and [architecture](architecture.md).

## Alpha.1 funded Orchard acceptance

The follow-up campaign used both SDK test accounts through encrypted CLI keystores. It completed **23 confirmed transactions**, **15 scenarios**, and **16 exact contract-rejection checks** across DAO governance and the core business lifecycles of all eight navigators. Indexer data was checked against on-chain proposal commitments. [Public transaction evidence](orchard-acceptance.json) records hashes, costs and the completed-campaign rerun; [runner instructions and coverage limits](orchard-testing.md) explain reproduction.

Live testing found a proposal-preparation bug: Quai uses the parent work object's timestamp for the EVM clock. SDK `0.1.0-alpha.3` verifies the parent link before reading historical votes. A captured Orchard block reproduces the failure offline. SDK validation passed 339 tests plus coverage, declarations and package checks; Node 22 and 24 also passed the complete suite.

CLI `0.1.0-alpha.1` exposes bounded decoded reverts without dumping raw RPC errors. It renames `--env-file` to `--key-env-file` because Node processes its own `--env-file` option before application validation. Internal child processes separate runtime arguments with `--`. The suite includes a dotenv containing a forbidden Node preload to prove the new flag does not load runtime settings.

The final 64-test CLI suite passed on Node 22, 24 and 26. A subsequent regression verifies the harness's bounded read retries on all three versions, bringing coverage to 65 unique tests. Runtime dependency audit found zero known vulnerabilities. A fixed-delay TUI test was replaced with a bounded wait for its actual read result.

Orchard paused while confirming budget cancellation. The CLI kept the hash, returned `TX_PENDING`, and recovered the original successful transaction after block production resumed. The harness now preserves intermediate budget assertions across that resume and retries only known reads and unsigned simulations for transient RPC failures. Sends and ambiguous outcomes are never automatically retried.

This run does not cover every privileged branch, fresh CLI deployments, permit variants, hour-long subscription delinquency or budget period rollover. The earlier local ABI, Solidity and TUI tests still provide complementary coverage; the live run does not replace those tests or establish finality.

## GitHub release path

Releases use matching GitHub version tags and npm trusted publishing. The CLI workflow validates the package and a clean registry consumer, transfers the tested archive to a separate publisher job, and verifies its checksum before publication with provenance. Tests cover package/tag/repository mismatches, modified archives and refusal to run the publisher from a workstation. The complete local suite passed 68 tests after these additions.

The first GitHub matrix caught Ink suppressing live rendering when CI variables are present, including inside the real terminal fixture. The TUI now explicitly selects interactive rendering after the entry point verifies stdin/stdout are terminals. Its interactive fixtures select the same mode; the workflow retains the CI environment so it exercises this condition.

SDK `0.1.0-alpha.3` was published by [GitHub run 34700999432](https://github.com/DAO-Ships/daoships-sdk/actions/runs/34700999432), after source/contract acceptance and CI passed on commit `ac697f6ac8c80344c33ef94d5255ff324f850a5c`. The registry archive matches the GitHub-tested artifact, and npm provenance identifies that commit and `v0.1.0-alpha.3`. The CLI lockfile uses this published archive's integrity. See [release instructions](releasing.md) for the CLI's independent trusted publisher setup and release sequence.
