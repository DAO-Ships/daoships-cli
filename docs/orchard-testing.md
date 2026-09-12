# Live Orchard acceptance

The opt-in runner drives `dist/bin.js` as a separate process for every command. It uses the SDK's dedicated Orchard DAO and eight navigator fixtures, recorded in `scripts/orchard/fixtures.json`. All sends, including mock asset minting through DAO proposals, use CLI keystores and the CLI transaction journal. No test imports a raw signing wallet into the runner.

```sh
npm run build
npm run test:orchard                         # offline plan; no keys or network
npm run test:orchard -- --read               # live fixture and indexer checks; no keys
npm run test:orchard -- --execute            # funded testnet transactions
```

Run from the CLI directory. The default key source is `../daoships-sdk/.env`, using `ORCHARD_PRIVATE_KEY` and `ORCHARD_MEMBER_PRIVATE_KEY`. Override it with `--key-env-file /path/to/.env`. Both accounts must match the public fixture owners and have at least 0.1 QUAI. Startup verifies chain 15000, DAO token/avatar identity, vault ownership/threshold and all navigator identities. These are disposable SDK acceptance contracts; never substitute a production DAO.

The source dotenv file is read without modification. On first execution, the runner writes each key to a temporary 0600 file, imports it through `wallet import`, and removes that file immediately. The randomly generated password and encrypted keystores remain under `.daoships/orchard-acceptance/` for recovery. The directory must be 0700; key and password values never appear in command arguments, logs or evidence. Child processes receive a small environment allowlist. The state directory is ignored and excluded from the npm package.

The core suite checks:

| Area | Live behavior |
| --- | --- |
| Wallet and vault | Both keystores, owner authorization, proposal, approval and execution |
| DAO | Proposal submission, snapshot-aware voting, processing, cancellation and ragequit |
| Onboarder | Native tribute, minted shares, rejected underpayment |
| ERC20 Tribute | Missing allowance rejection, exact approval, treasury receipt, minted shares and consumed allowance |
| NFT Gated | Ownership, successful mint and duplicate-use rejection |
| Signal | Poll creation, weighted vote and duplicate-vote rejection |
| Timelock | Unauthorized queue rejection, vault queue, early execution rejection, real ten-minute delay, commitment verification and replay rejection |
| Vesting | Timed vesting, beneficiary authorization, exact mint and duplicate-claim rejection |
| Budget | Treasury funding, enabled module, authorized spending, period/total accounting, over-limit rejection and cancellation |
| Subscription | Governance enrollment, payment, extended membership, rejected underpayment and early collection |
| Recovery | Every transaction reconciled from the CLI journal without a new send |

Receipts and state changes must both agree. Negative tests require decoded contract reverts; a timeout or disconnected RPC cannot count as a successful rejection. Receipt confirmation depth is two blocks, not a finality guarantee.

## Limits and recovery

At most 80 transaction attempts are reserved, with a gas ceiling of 12,000,000 per transaction, 1,000 wei per native-value send and 10,000 wei aggregate native value. Network fees are additional; these are gas-unit and transfer limits, not an aggregate fee cap. Test mock ERC20 units, NFTs, shares and loot are separate from native QUAI.

Public evidence is saved atomically in `state.json` inside the private directory. Every operation has a stable ID, intent digest and reviewed transaction hash. Rerun the **same command with the same directory** after an ordinary interruption. Existing journal records are recovered before any new simulation, since replaying an already-applied call may revert. Pending, reverted, ambiguous or provably unsent attempts stop for inspection; the runner never creates a replacement ID automatically.

Transient failures of known read commands and unsigned simulations receive at most two retries. Sends, local wallet changes, decoded contract reverts and pending outcomes are never retried automatically.

```sh
node dist/bin.js --network orchard \
  --config-dir .daoships/orchard-acceptance/cli --json \
  tx show '<operation-id>'
node dist/bin.js --network orchard \
  --config-dir .daoships/orchard-acceptance/cli --json \
  tx recover '<operation-id>'
```

An exclusive `running.lock` prevents two runners sharing the same state. After a process crash, check that its recorded PID and all CLI children have exited, reconcile pending transactions, then remove the stale lock. Do not delete the journal or start a new directory to bypass an uncertain send. Keep the directory until every transaction is resolved. Separate CLI configuration directories cannot coordinate nonces with each other or with the SDK harness; run only one signer workflow at a time for these accounts.

## Coverage boundaries

This suite complements the existing SDK deployment tests and CLI automated ABI/TUI tests. It does not redeploy DAOs or navigators. It exercises representative business lifecycles, not every possible privileged method, ERC20 permit variant, revocable vesting case or configuration combination. Subscription delinquency and budget period rollover take at least one additional hour and are not part of the core run. Mainnet remains read-only in acceptance testing.

The fixtures are a resumable campaign. A new campaign needs fresh reviewed SDK fixtures; changing only the directory does not reset mint caps, subscriptions or NFT usage on chain.

## Clock regression found during acceptance

At Orchard block 7,782,799, the work object timestamp was 1,789,165,231 and its verified parent timestamp was 1,789,165,223. Reading historical votes at 1,789,165,230 reverted; reading at 1,789,165,222 returned 1,000 votes. This matches [Quai's EVM clock implementation](https://github.com/dominant-strategies/go-quai/blob/main/core/evm.go), which takes the parent work object's time. The SDK proposal preflight now verifies that parent and uses its timestamp minus one, retaining the selected block for state reads and simulation. The captured public block evidence is an offline SDK regression fixture.
