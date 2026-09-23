# Changelog

## Unreleased

- Verify reverted navigator deployments on older mainnet blocks. quais (through
  1.0.0-alpha.57) throws `BAD_DATA` from `getBlock()` for mainnet blocks more than a
  few hundred thousand behind the head, whose `totalEntropy` the node returns as null,
  so `deploy recover` could not settle a reverted CREATE there. The receipt block is
  now read raw when quais cannot format it; mismatched blocks still fail closed.
- Mined-deployment recovery and transaction recovery run through the SDK and get the
  same fix once the CLI moves to an SDK release that includes it (unreleased in
  `@daoships/sdk` after `0.1.0-alpha.3`).

## 0.1.0-alpha.2

- Process and recover intentional defeated-proposal closures successfully, reporting `outcome: "defeated"`, `executed: false`, and `closed: true`. Closures no longer need indexed calldata.
- Preserve failure results for retention vetoes, reverted actions, missing events and mismatched proposal IDs.

## 0.1.0-alpha.1

- Publish from GitHub version tags using npm trusted publishing, provenance and the exact tested archive.

- Added an opt-in, resumable Orchard CLI acceptance harness using both SDK test accounts, encrypted keystores, dedicated DAO/navigator fixtures and bounded transaction attempts.
- Decode bounded contract revert details in CLI/TUI errors, distinguishing known contract rejection from an RPC failure without exposing raw provider errors.
- Rename `--env-file` to `--key-env-file` for explicit key import. Node intercepts `--env-file` before application validation, even after the script path; the new flag avoids automatic environment loading. Internal child commands also separate Node arguments with `--`.
- Use SDK `0.1.0-alpha.3`, correcting the parent-block EVM timestamp used by proposal preflights.
- Wait for the actual asynchronous read result in the TUI interaction test instead of relying on a short fixed delay.
- Keep the TUI interactive in a verified terminal even when CI environment variables are present.

## 0.1.0-alpha.0

Initial npm release of the DAOShips CLI, built against `@daoships/sdk@0.1.0-alpha.2`.

- 88 shared commands for humans and agents, with versioned JSON output and discoverable schemas.
- All 353 ABI functions across 17 contracts, all eight navigator kinds and all 25 indexer tables.
- Responsive Ink workspace with search, guided ABI and constructor forms, transaction reviews, paging, exports and a recovery journal.
- Encrypted V3 keystores: account creation/import, legacy migration, backup/restore, password changes, verification and confirmed removal.
- TUI terminal handoff for hidden secret entry, tested using a real PTY.
- Orchard and mainnet support, SDK simulations, bounded gas/value, atomic nonce recovery, native CREATE execution and verified deployment workflows.
- Audit fixes for concurrent configuration updates, sender/DAO selection, private-file handling, keystore KDF bounds, child exit codes, cancellation, clear gas-cap errors and vault/token business outcomes.
- Bounded discovery and reconciliation of ordinary transaction replacements.
