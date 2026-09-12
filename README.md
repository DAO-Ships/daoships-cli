# DAOShips CLI

A terminal workspace for collective decisions on Quai. Browse DAOs, participate in governance, manage treasury and navigators, and recover transactions from the same commands humans and agents use in scripts.

Built against the **`@daoships/sdk@0.1.0-alpha.3`**, with React and Ink. The CLI is distributed on npm under the `alpha` tag.

## Start here

Node **22.13 or newer** is required; Node 24 LTS is a good default.

```sh
npm install -g @daoships/cli@alpha
daoships tui
```

`ds` is a shorter alias for `daoships`. From source, run `npm ci && npm run build`, then `node dist/bin.js tui` or `npm run dev`.

The initial network is **Orchard** (chain 15000). No key is needed to browse. Saved defaults, encrypted keystores and transaction recovery records live in `~/.config/daoships/state.sqlite` (or `$XDG_CONFIG_HOME/daoships`). Override the directory with `--config-dir` or `DAOSHIPS_CONFIG_DIR`.

```sh
daoships status
daoships dao list
daoships dao use <dao-address>
daoships dao show
daoships proposal list
daoships navigator list
daoships --network mainnet status
```

## Your terminal workspace

The TUI includes Discover, Overview, Proposals, Treasury, Members, Navigators, Activity, Journal, Tools and Settings. Its workspace shows the active network, distinguishes chain reads from indexed discovery, refreshes every 15 seconds, and keeps long lists and exact JSON details scrollable. Wide terminals have a sidebar; narrower terminals retain keyboard navigation.

| Key | Action |
| --- | --- |
| `1`–`9`, `0`, or `Tab` | Switch sections; Shift Tab goes back |
| `↑`/`↓`, `j`/`k` | Select a row |
| `Enter` | Open a DAO, inspect a row, or launch a command |
| `/` | Filter the current page |
| `Ctrl K` | Search the complete command palette |
| `a` | Explore a DAO or navigator's contract methods |
| `+` | Create a proposal, deploy a navigator, or add a wallet in Settings |
| `r`, `n`, `b` | Refresh, next page, previous page |
| `e` in details | Export exact JSON to a new local file |
| `?`, `Esc`, `q` | Keyboard guide, back, quit |

Navigator deployment has a constructor wizard. Contract actions derive their forms from the SDK's ABI, including arrays, tuples, booleans and overloaded methods. Paste is supported; text fields support arrow keys, Ctrl A/E and Ctrl U.

Writes first open a review. **`d` shows the full prepared data; `s` signs and sends.** The TUI delegates signing to a one-shot child command with the reviewed hash and a durable operation ID. Interrupted or uncertain operations remain in Journal. Proposal details have shortcuts for voting, sponsoring, processing and cancelling.

## Encrypted wallets

Private keys are encrypted as **Web3 Secret Storage V3** using quais, AES-128-CTR and scrypt (`N=131072, r=8, p=1`). The encrypted JSON and public wallet profile are committed together in the owner-only SQLite state database. `wallet export` produces a standard portable V3 JSON file. Passwords and plaintext keys are never saved in configuration or recovery records.

```sh
daoships wallet create captain             # Generates a Cyprus-1 Quai account
daoships wallet import member              # Hidden key and password prompts
daoships wallet use member
daoships wallet list
daoships wallet verify member              # Decrypts and checks identity locally
daoships wallet export member member.json  # Encrypted backup; never overwrites
daoships wallet change-password member
daoships wallet import-keystore restored member.json
```

New passwords require at least 12 characters and confirmation. The TUI offers these operations in Settings and the command palette, with saved-wallet choices. It suspends its terminal while a short-lived child handles hidden secret entry, then restores your workspace. Ctrl C cancels secret entry. Browsing and previews do not unlock a wallet.

For agents, provide **file paths**, never secret values in command arguments:

```sh
# key.txt contains a 0x-prefixed private key. password.txt contains a strong password.
chmod 600 key.txt password.txt
daoships --json --key-file key.txt --password-file password.txt wallet import agent
export DAOSHIPS_KEYSTORE_PASSWORD_FILE=/absolute/path/password.txt
daoships --json --wallet agent wallet verify agent
```

`--password-file` or the exported `DAOSHIPS_KEYSTORE_PASSWORD_FILE` supplies the current password. When restoring an encrypted backup or changing a password, `--new-password-file` or exported `DAOSHIPS_NEW_PASSWORD_FILE` supplies the new password. Otherwise the CLI prompts on a terminal; scripts fail explicitly if a required secret source is missing. Password files preserve spaces and remove only one trailing newline. Secret files must be owner-only regular files without symlinks or hard links.

Existing environment wallets require `wallet migrate <name>` before signing. A named variable can also be used as an explicit import source:

```sh
chmod 600 ../daoships-sdk/.env
daoships --key-env-file ../daoships-sdk/.env wallet import orchard ORCHARD_PRIVATE_KEY
daoships --key-env-file ../daoships-sdk/.env wallet migrate existing-profile
```

Process environment takes precedence over the import `.env` file. Import and migration copy the account into an encrypted keystore; they do not delete the plaintext source. Remove that source once you have verified an encrypted backup. Signing never falls back to environment keys. Weak external keystores are refused unless `wallet import-keystore` uses `--allow-weak-keystore`; even then the imported key is immediately re-encrypted at the current strength. Excessive KDF costs are always rejected.

`wallet remove <name>` deletes the local profile and encrypted key after confirmation (`--yes` for agents). Backups remain usable with their original passwords. Use `wallet watch <public-address>` for watch-only work. `--wallet` overrides the selected profile for a command; `--from` specifies the sender to simulate, and must match the unlocked account for execution. Both networks use Cyprus-1 Quai accounts.

See [keystore storage and security boundaries](docs/security.md).

## One-shot commands and agents

```sh
daoships --schema
daoships --json run "dao show" '{"dao":"<dao-address>"}'
daoships contract methods DAOShip
daoships navigator methods BudgetNavigator
daoships indexer tables
```

All **353 ABI functions across 17 SDK contracts**, including all eight navigator kinds, are exposed by `contract read/write/encode` and the navigator aliases. Canonical signatures disambiguate overloads. All **25 indexed tables** are queryable. The 88 shared commands cover common DAO, proposal, token, deployment, metadata, governance and recovery flows. `contract events` discovers event schemas; `tx events` decodes named receipt fields from an exact emitter, useful for retrieving newly created proposal, schedule or budget IDs. See the [generated command reference](docs/commands.md) and [machine-readable definitions](docs/commands.json).

`--json` writes one versioned envelope to stdout. Diagnostics and submission events go to stderr. Exact amounts, IDs represented as bigints, and large counters are **decimal strings**. Never pass token amounts through floating-point numbers. JSON arguments accept inline JSON or `@file.json`.

```json
{"schemaVersion":1,"ok":true,"command":"network list","network":"orchard","chainId":15000,"data":{}}
```

Failures use `ok:false` and `error:{code,message,details}`. Exit codes are 0 success, 1 connection/internal failure, 2 usage, 3 precondition/business failure, 4 uncertain transaction outcome requiring recovery, 5 declined, and 130 interrupted. `status` can succeed with `data.degraded:true`; `doctor` is the stricter health check.

## Preview, execute, recover

```sh
# Preview and simulate; no private key is read.
daoships --from <member-address> proposal vote 7 yes

# Execute the reviewed intent. Use a unique, stable ID for each intended operation.
daoships --json --send --yes --id vote-7-yes proposal vote 7 yes

# Discover any ABI method, including overloads.
daoships contract read SharesERC20 <token-address> balanceOf '["<account-address>"]'
daoships contract encode QuaiVault <vault-address> 'proposeTransaction(address,uint256,bytes)' \
  '["<target-address>","0","0x..."]'

daoships tx list
daoships tx show vote-7-yes
daoships tx recover vote-7-yes
# If a different application replaced its nonce, scan an explicit window (at most 128 blocks).
daoships tx replacements vote-7-yes <first-block> <last-block>
daoships --json run "tx recover" '{"id":"vote-7-yes","replacement":"<candidate-hash>"}'
```

Writes preview by default. `--send` executes; interactive one-shot commands prompt unless `--yes` is supplied. Noninteractive sends require **both `--yes` and `--id`**. Add `--expect-hash <reviewHash>` to bind execution to a preview. `--max-value <wei>` caps transferred QUAI; `--max-gas <units>` caps the gas limit (default 10,000,000). Network fees are additional. Receipt depth defaults to two blocks and can be changed with `--confirmations`.

SQLite uses atomic revisions, WAL and full synchronization. Commands sharing one account must share its config directory. Known broadcast hashes and the account's nonce floor persist across restarts. An uncertain broadcast blocks further sends from that account until reconciled; **no command silently resends an existing operation ID**. Repeating a named command may fail its fresh simulation after the original transaction changes state; use `tx recover` to inspect the original operation. `tx abandon` only releases an operation provably marked as not having entered broadcast.

Proposal processing checks the committed calldata and the DAO's inner execution outcome. `proposal process` also closes an unprocessed defeated proposal without needing indexed calldata; its result reports `outcome: "defeated"`, `executed: false`, and `closed: true`. A retention veto against intended action execution remains a failure. A mined outer transaction alone does not make a failed proposal successful. The same checks apply when recovering an ordinary transaction. Vault execution rejects inner failure events; token transfers, approvals and delegation require matching events, including through generic commands. Other contract results include named events and logs for subsequent state inspection.

## Deploying navigators and DAOs

```sh
# config.json contains the named constructor fields shown by this command.
daoships navigator constructors VestingNavigator
daoships --from <deployer> --output navigator-plan.json navigator plan VestingNavigator @config.json
daoships navigator execute @navigator-plan.json
daoships --send --yes --id vesting-create navigator execute @navigator-plan.json

# Creation and activation are separate operations.
daoships workflow prepare @navigator-plan.json activate
daoships workflow propose @navigator-plan.json activate
```

The CLI uses the SDK's bundled navigator bytecode, grinds a Cyprus-1 CREATE address, and stores the locally calculated signed hash before broadcasting. Successful creation verifies constructor provenance and deployed code. The plan contains explicit activation and optional treasury-funding steps. Activation normally requires a DAO proposal: submit, sponsor, vote, process, then `workflow verify <plan> activate <process-hash>`. Signal activation requires the complete current navigator endorsement set and Poster address in the planning options. Budget activation enables its vault module through governance. Deploying alone does not grant permissions.

DAO launching uses `launch plan @launch-config.json` to discover factory identities and mine salts, then `launch execute @saved-plan.json`. Direct, existing-vault and new-vault routes are supported. The existing-vault routes include explicit module and MultiSend setup steps; use authorized QuaiVault proposals/approvals/execution through its full contract interface, then verify the executed steps. A proposed vault action is not completed setup. `workflow execute` handles direct transaction steps, including optional treasury funding.

See [deployment inputs and examples](docs/deployments.md). Plans exported with `--output` can be read back directly, including their JSON envelopes.

## Development and validation

```sh
npm test             # Keystores, ABI, commands, recovery, local RPC, and real-terminal TUI tests
npm run test:package # Inspect the real npm tarball and run it outside the project
npm run check        # Both
npm run test:orchard # Offline plan for the opt-in live testnet suite
```

Tests run on Node 22, 24 and 26. The real-terminal test uses Python 3 and a POSIX PTY (available on the Linux CI runner). Tests use isolated temporary databases and synthetic offline signers. They do not load the funded SDK harness keys or submit public-chain transactions. Live validation has covered Orchard and mainnet RPC/indexer connections and Orchard DAO/navigator reads. A funded Orchard account also completed a zero-value self-transfer through an encrypted CLI wallet, followed by journal recovery and a repeated-ID check proving no rebroadcast. The CLI has not yet repeated every DAO/navigator mutation on live contracts.

Runtime notes and SDK integration findings are in [docs/architecture.md](docs/architecture.md).

The [Orchard acceptance runner](docs/orchard-testing.md) imports the two funded SDK test accounts into encrypted CLI keystores and exercises DAO governance and all eight navigator business lifecycles. Live sends require an explicit `npm run test:orchard -- --execute`; ordinary tests never access those keys or broadcast transactions.

Releases are published by pushing a matching GitHub version tag. See [release instructions](docs/releasing.md).
