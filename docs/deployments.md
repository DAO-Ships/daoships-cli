# Deployment inputs

Use `--from` or an active wallet profile when planning. All amounts are raw units, represented as decimal strings. The examples contain placeholders; replace addresses before running them.

## Vesting navigator

`config.json`:

```json
{
  "daoShip": "<dao-address>",
  "name": "Contributor vesting",
  "description": "Contributor share vesting schedules"
}
```

```sh
daoships --output navigator-plan.json navigator plan VestingNavigator @config.json
daoships navigator execute @navigator-plan.json
daoships --send --yes --id contributor-vesting navigator execute @navigator-plan.json
daoships workflow prepare @navigator-plan.json activate
daoships --send --yes --id contributor-vesting-proposal workflow propose @navigator-plan.json activate
```

The submit result includes the proposal ID. Use the proposal commands to sponsor, vote and process it after the configured periods. Verify activation with the **process** receipt:

```sh
daoships workflow verify @navigator-plan.json activate <process-transaction-hash>
```

Other constructor schemas are available through `navigator constructors <kind>`; the TUI builds each constructor form from the same ABI.

## Signal options and treasury funding

The optional final JSON argument of `navigator plan` or `navigator deploy` accepts:

```json
{
  "signalEndorsement": {
    "poster": "<poster-address>",
    "currentNavigators": [
      { "address": "<existing-navigator>", "type": "BudgetNavigator" }
    ]
  },
  "treasuryFunding": {
    "token": "0x0000000000000000000000000000000000000000",
    "amount": "1000000000000000000"
  }
}
```

Signal endorsement replaces the complete set. Read and verify the current set immediately before proposing activation. The CLI does not infer its completeness from one indexer page. Omit `signalEndorsement` for other navigator kinds. `treasuryFunding` is optional; the zero token address means QUAI. A token address means an ERC-20 transfer from the deployer to the DAO vault. After activation, use `workflow execute <plan> fund-treasury` to preview, and add the usual execution flags to send.

## DAO launch

`launch-config.json` for an existing vault:

```json
{
  "launcher": "<combined-launcher-address>",
  "route": "existing-vault",
  "existingVault": "<vault-address>",
  "startSalt": "0",
  "parameters": {
    "shareTokenName": "Example Shares",
    "shareTokenSymbol": "SHARE",
    "lootTokenName": "Example Loot",
    "lootTokenSymbol": "LOOT",
    "initialization": {
      "governanceConfig": {
        "votingPeriod": 300,
        "gracePeriod": 60,
        "proposalOffering": "0",
        "quorumPercent": "5000",
        "sponsorThreshold": "1",
        "minRetentionPercent": "5000",
        "defaultExpiryWindow": 604800
      },
      "navigators": [],
      "navigatorPermissions": [],
      "initMembers": ["<member-address>"],
      "initShareAmounts": ["1000000000000000000"],
      "initLootAmounts": ["0"],
      "guildTokens": ["0x0000000000000000000000000000000000000000"],
      "pauseSharesOnLaunch": false,
      "pauseLootOnLaunch": false
    }
  }
}
```

```sh
daoships --output launch-plan.json launch plan @launch-config.json
daoships launch execute @launch-plan.json
daoships --send --yes --id launch-example launch execute @launch-plan.json
```

The planner reads factory references at a checked block, supplies the matching MultiSend address, and mines the three DAO/token salts. Choose a fresh `startSalt` range for another launch. Supplied `parameters.sharesSalt`, `lootSalt` and `daoShipSalt` can fix previously mined salts.

`route:"direct"` uses the direct DAOShipLauncher and its caller-sensitive CREATE2 predictions. It still takes the combined launcher address for deployment discovery and an existing vault. `route:"new-vault"` instead takes `vaultOwners`, `vaultThreshold`, and `vaultProxyBytecode`, with optional `vaultSalt`. The proxy creation bytecode must match the selected vault factory's artifact. The planner mines the vault address after predicting the DAO. The combined new-vault launcher performs the initial module/MultiSend setup.

Existing vault routes leave `enable-dao-module` and `allow-multisend` steps. `workflow prepare` returns their exact calls. An authorized vault owner can use `contract write QuaiVault <vault> 'proposeTransaction(address,uint256,bytes)' <args>`, then the vault's approval/execution methods. Verify using the final execution receipt. The CLI does not bypass owner thresholds, timelocks or DAO voting periods.
