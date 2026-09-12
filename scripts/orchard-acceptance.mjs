import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Interface, ZeroAddress } from 'quais';
import { encodeGovernanceConfig } from '@daoships/sdk';
import { Harness, limits } from './orchard/harness.mjs';

const { values } = parseArgs({ options: { execute: { type: 'boolean' }, read: { type: 'boolean' }, plan: { type: 'boolean' },
  'key-env-file': { type: 'string', default: '../daoships-sdk/.env' }, 'fixtures': { type: 'string', default: 'scripts/orchard/fixtures.json' },
  directory: { type: 'string', default: '.daoships/orchard-acceptance' } } });
assert([values.execute, values.read, values.plan].filter(Boolean).length <= 1, 'Choose exactly one mode: --plan, --read or --execute.');
if (!values.execute && !values.read) {
  console.log(JSON.stringify({ network: 'orchard', chainId: 15000, sends: false, limits,
    scenarios: ['encrypted wallets', 'fixture identity', 'vault approval/execution', 'DAO proposal/vote/process/cancel',
      'native and ERC20 onboarding', 'NFT gating', 'signal voting', 'vesting claim', 'budget spending/cancellation',
      'subscription enrollment/payment', 'ten-minute timelock execution', 'ragequit', 'durable recovery'],
    execute: 'npm run test:orchard -- --execute',
    limitations: ['Reuses the SDK disposable fixtures; does not test new DAO/navigator deployment.',
      'Subscription delinquency and budget period rollover require an additional hour-long phase.'] }, null, 2));
} else {
  const fixtures = JSON.parse(await readFile(resolve(values.fixtures), 'utf8'));
  const h = new Harness(values.directory, fixtures);
  try { await h.open(); await run(h, Boolean(values.execute), resolve(values['key-env-file'])); }
  catch (error) {
    console.error(JSON.stringify({ status: 'stopped', directory: resolve(values.directory), code: error.code ?? 'ASSERTION',
      message: error.message, details: error.details })); process.exitCode = 1;
  } finally { await h.close(); }
}

async function run(h, execute, envFile) {
  const { dao, shares, loot, vault, accounts, navigators: nav } = h.fixtures;
  const read = (kind, method, args = []) => h.read(kind, nav[kind], method, args);
  const write = (key, kind, method, args = [], wallet = 'member', value = '0') => h.write(key, kind, nav[kind], method, args, wallet, value);
  const reject = (key, kind, method, args = [], wallet = 'member', value = '0') => h.rejected(key, kind, nav[kind], method, args, wallet, value);
  const tokenBalance = (address, account = accounts.member) => h.cli('token balance', { address, account });
  const encode = (kind, address, method, args) => h.cli('contract encode', { kind, address, method, args });
  const action = async (kind, address, method, args) => { const call = await encode(kind, address, method, args); return { to: address, data: call.data, value: '0', operation: 0 }; };
  const getEvent = async (kind, address, receipt, event) => {
    const events = await h.events(kind, address, receipt.hash, event); assert.equal(events.length, 1, `Expected one ${event} event.`); return events[0];
  };
  const vaultCall = async (key, kind, address, method, args) => {
    const call = await encode(kind, address, method, args);
    const proposal = await h.write(`${key}:propose`, 'QuaiVault', vault, 'proposeTransaction(address,uint256,bytes)', [address, '0', call.data]);
    const { txHash } = await getEvent('QuaiVault', vault, proposal, 'TransactionProposed');
    await h.write(`${key}:approve`, 'QuaiVault', vault, 'approveTransaction', [txHash]);
    return h.write(`${key}:execute`, 'QuaiVault', vault, 'executeTransaction', [txHash]);
  };
  const submit = async (key, actions) => {
    const receipt = await h.send(`${key}:submit`, 'proposal submit', { dao, actions, details: `CLI Orchard acceptance ${h.state.run} ${key}` }, 'member');
    const event = await getEvent('DAOShip', dao, receipt, 'SubmitProposal');
    const proposal = String(event.proposal);
    await h.until('proposal-snapshot', async () => {
      const head = (await h.cli('status')).head; assert(head, 'Chain unavailable.'); return BigInt(head.timestamp) > BigInt(event.timestamp);
    }, 120000);
    await h.send(`${key}:vote`, 'proposal vote', { dao, proposal, vote: 'yes' }, 'member');
    return proposal;
  };
  const processProposal = async (key, proposal, actions) => {
    await h.until('proposal-voting-window', async () => {
      // Contract state uses the EVM clock; a work object's timestamp can be ahead.
      return ['5', '7'].includes(String(await h.read('DAOShip', dao, 'state', [proposal])));
    }, 600000);
    return h.send(`${key}:process`, 'proposal process', { dao, proposal, actions }, 'member');
  };

  // Chain reads repeat on every run; cached success is never a substitute for identity checks.
  const status = await h.cli('doctor'); assert.equal(status.head.number > 0, true);
  const actual = await h.cli('dao show', { dao });
  assert.equal(actual.avatar.toLowerCase(), vault.toLowerCase());
  assert.equal(actual.sharesToken.toLowerCase(), shares.toLowerCase());
  assert.equal(actual.lootToken.toLowerCase(), loot.toLowerCase());
  assert.equal(await h.read('QuaiVault', vault, 'isOwner', [accounts.owner]), true);
  assert.equal(await h.read('QuaiVault', vault, 'threshold'), '1');
  const entries = Object.entries(nav);
  for (let offset = 0; offset < entries.length; offset += 2) {
    const results = await Promise.allSettled(entries.slice(offset, offset + 2).map(async ([kind, address]) => {
      assert.equal((await h.read(kind, address, 'daoShip')).toLowerCase(), dao.toLowerCase());
      assert.equal(await h.read(kind, address, 'navigatorType'), kind);
    }));
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  }
  h.progress('fixtures-verified', { chainId: 15000, dao, navigators: Object.keys(nav).length });
  if (!execute) return;
  await h.wallets(envFile);

  const governance = await h.memo('governance', async () => encodeGovernanceConfig({ votingPeriod: Number(actual.votingPeriod), gracePeriod: Number(actual.gracePeriod),
    proposalOffering: BigInt(actual.proposalOffering), quorumPercent: BigInt(actual.quorumPercent), sponsorThreshold: BigInt(actual.sponsorThreshold),
    minRetentionPercent: BigInt(actual.minRetentionPercent), defaultExpiryWindow: Number(actual.defaultExpiryWindow) }));
  // Queue first so the mandatory ten minutes overlap the other scenarios.
  await h.scenario('timelock-queue', async () => {
    await reject('unauthorized-timelock-queue', 'TimelockNavigator', 'queueChange', [governance]);
    const tx = await vaultCall('timelock', 'TimelockNavigator', nav.TimelockNavigator, 'queueChange', [governance]);
    const event = await getEvent('TimelockNavigator', nav.TimelockNavigator, tx, 'ChangeQueued');
    await h.memo('timelock-change', async () => event);
    await reject('premature-timelock', 'TimelockNavigator', 'executeChange', [event.changeId, governance]);
  });
  const setup = await h.memo('setup-actions', async () => {
    const { tribute, nft, tokenId } = await h.memo('mock-assets', async () => ({ tribute: await read('ERC20TributeNavigator', 'tributeToken'),
      nft: await read('NFTGatedNavigator', 'gateToken'), tokenId: String(Date.now()) }));
    const mint = new Interface(['function mint(address,uint256)']);
    return [await action('VestingNavigator', nav.VestingNavigator, 'createSchedule', [accounts.member, '60', '0', '20', '90', false]),
      await action('BudgetNavigator', nav.BudgetNavigator, 'createBudget', [accounts.member, ZeroAddress, '100', '200', '3600', '0', '0']),
      await action('SubscriptionNavigator', nav.SubscriptionNavigator, 'enroll', [accounts.member]),
      // Test-only mocks are minted by the real DAO proposal, through the CLI.
      { to: tribute, data: mint.encodeFunctionData('mint', [accounts.member, '100']), value: '0', operation: 0 },
      { to: nft, data: mint.encodeFunctionData('mint', [accounts.member, tokenId]), value: '0', operation: 0 }];
  });
  await h.scenario('governance-submit-vote', async () => { await h.memo('setup-proposal', () => submit('setup', setup)); });

  await h.scenario('native-onboarding', async () => {
    const before = await h.memo('onboard-shares-before', () => tokenBalance(shares));
    await reject('onboard-underpayment', 'OnboarderNavigator', 'onboard()', [], 'member', '0');
    await write('onboard-native', 'OnboarderNavigator', 'onboard()', [], 'member', '5');
    assert.equal(BigInt(await tokenBalance(shares)) - BigInt(before), 5n);
  });
  await h.scenario('signal-voting', async () => {
    const tx = await write('poll-create', 'SignalNavigator', 'createPoll', ['CLI live acceptance', '2', '0', '180']);
    const poll = await getEvent('SignalNavigator', nav.SignalNavigator, tx, 'PollCreated');
    await write('poll-vote', 'SignalNavigator', 'vote', [poll.pollId, '1']);
    await reject('duplicate-signal-vote', 'SignalNavigator', 'vote', [poll.pollId, '1']);
    const results = await read('SignalNavigator', 'getResults', [poll.pollId]); assert(BigInt(results[1]) > 0n); assert.equal(results[0], '0');
    await h.memo('poll', async () => poll);
  });
  await h.scenario('governance-process', async () => {
    const tx = await processProposal('setup', h.state.facts['setup-proposal'], setup);
    await h.memo('vesting', () => getEvent('VestingNavigator', nav.VestingNavigator, tx, 'ScheduleCreated'));
    await h.memo('budget', () => getEvent('BudgetNavigator', nav.BudgetNavigator, tx, 'BudgetCreated'));
    await h.memo('subscription', () => getEvent('SubscriptionNavigator', nav.SubscriptionNavigator, tx, 'MemberEnrolled'));
  });
  await h.scenario('erc20-onboarding', async () => {
    const { tribute } = h.state.facts['mock-assets'];
    const before = await h.memo('erc20-before', async () => ({ shares: await tokenBalance(shares), treasury: await tokenBalance(tribute, vault) }));
    await reject('missing-erc20-allowance', 'ERC20TributeNavigator', 'onboard(uint256,uint256)', ['5', '0']);
    await h.send('erc20-approve', 'token approve', { address: tribute, to: nav.ERC20TributeNavigator, amount: '5' }, 'member');
    await write('erc20-onboard', 'ERC20TributeNavigator', 'onboard(uint256,uint256)', ['5', '0']);
    assert.equal(BigInt(await tokenBalance(shares)) - BigInt(before.shares), 5n);
    assert.equal(BigInt(await tokenBalance(tribute, vault)) - BigInt(before.treasury), 5n);
    assert.equal(await h.read('SharesERC20', tribute, 'allowance', [accounts.member, nav.ERC20TributeNavigator]), '0');
  });
  await h.scenario('nft-gating', async () => {
    const { tokenId } = h.state.facts['mock-assets'];
    const before = await h.memo('nft-shares-before', () => tokenBalance(shares));
    await reject('wrong-nft-owner', 'NFTGatedNavigator', 'onboard(uint256)', [tokenId], 'owner');
    await write('nft-onboard', 'NFTGatedNavigator', 'onboard(uint256)', [tokenId]);
    await reject('duplicate-nft-onboarding', 'NFTGatedNavigator', 'onboard(uint256)', [tokenId]);
    assert.equal(BigInt(await tokenBalance(shares)) - BigInt(before), 1n);
  });
  await h.scenario('subscription-payment', async () => {
    const before = h.state.facts.subscription.paidThrough;
    await reject('subscription-underpayment', 'SubscriptionNavigator', 'payFee', ['1', ZeroAddress]);
    const tx = await write('subscription-pay', 'SubscriptionNavigator', 'payFee', ['1', ZeroAddress], 'member', '1');
    const event = await getEvent('SubscriptionNavigator', nav.SubscriptionNavigator, tx, 'FeePaid');
    assert.equal(BigInt(event.paidThrough) - BigInt(before), 3600n); assert.equal(event.amount, '1');
    assert.equal(await read('SubscriptionNavigator', 'isCurrent', [accounts.member]), true);
    await reject('premature-subscription-collection', 'SubscriptionNavigator', 'collectFee', [accounts.member], 'owner');
  });
  await h.scenario('vesting-claim', async () => {
    const schedule = h.state.facts.vesting, before = await h.memo('vesting-shares-before', () => tokenBalance(shares));
    await h.until('vesting-maturity', async () => BigInt(await read('VestingNavigator', 'vested', [schedule.scheduleId])) === 60n, 180000);
    await reject('unauthorized-vesting-claim', 'VestingNavigator', 'claim', [schedule.scheduleId], 'owner');
    await write('vesting-claim', 'VestingNavigator', 'claim', [schedule.scheduleId]);
    assert.equal(BigInt(await tokenBalance(shares)) - BigInt(before), 60n);
    assert.equal(await read('VestingNavigator', 'claimable', [schedule.scheduleId]), '0');
    await reject('duplicate-vesting-claim', 'VestingNavigator', 'claim', [schedule.scheduleId]);
  });
  await h.scenario('budget-spending', async () => {
    const { budgetId } = h.state.facts.budget;
    await h.send('budget-fund', 'transfer', { to: vault, amount: '200' });
    assert.equal(await h.read('QuaiVault', vault, 'isModuleEnabled', [nav.BudgetNavigator]), true);
    await reject('unauthorized-budget-spend', 'BudgetNavigator', 'disburse', [budgetId, accounts.owner, '40'], 'owner');
    const before = await h.memo('budget-treasury-before', async () => (await h.cli('balance', { account: vault })).wei);
    await write('budget-disburse', 'BudgetNavigator', 'disburse', [budgetId, accounts.owner, '40']);
    assert.equal(BigInt(before) - BigInt((await h.cli('balance', { account: vault })).wei), 40n);
    // This rejection is checkpointed only after both accounting assertions.
    // Once cancellation has been attempted, current remaining amounts may be zero.
    if (!h.state.facts['rejected:budget-period-ceiling']) {
      assert.equal(await read('BudgetNavigator', 'remainingThisPeriod', [budgetId]), '60');
      assert.equal(await read('BudgetNavigator', 'remainingTotal', [budgetId]), '160');
      await reject('budget-period-ceiling', 'BudgetNavigator', 'disburse', [budgetId, accounts.owner, '61']);
    }
    await vaultCall('budget-cancel', 'BudgetNavigator', nav.BudgetNavigator, 'cancelBudget', [budgetId]);
    await reject('cancelled-budget-spend', 'BudgetNavigator', 'disburse', [budgetId, accounts.owner, '1']);
  });
  await h.scenario('proposal-cancellation', async () => {
    const receipt = await h.send('cancel:submit', 'proposal submit', { dao, actions: [{ to: accounts.owner, value: '0', data: '0x', operation: 0 }], details: 'CLI cancellation fixture' }, 'member');
    const event = await getEvent('DAOShip', dao, receipt, 'SubmitProposal');
    await h.send('cancel:cancel', 'proposal cancel', { dao, proposal: event.proposal }, 'member');
  });
  await h.scenario('timelock-execution', async () => {
    const change = h.state.facts['timelock-change'];
    await h.until('ten-minute-timelock', () => read('TimelockNavigator', 'isExecutable', [change.changeId]));
    await reject('timelock-wrong-commitment', 'TimelockNavigator', 'executeChange', [change.changeId, '0x']);
    await write('timelock-execute', 'TimelockNavigator', 'executeChange', [change.changeId, governance]);
    await reject('duplicate-timelock-execution', 'TimelockNavigator', 'executeChange', [change.changeId, governance]);
    assert.equal((await read('TimelockNavigator', 'queuedChanges', [change.changeId]))[5], true);
  });
  await h.scenario('ragequit', async () => {
    const before = await h.memo('ragequit-shares-before', () => tokenBalance(shares));
    await h.send('ragequit', 'dao ragequit', { dao, shares: '1', loot: '0', tokens: [ZeroAddress] }, 'member');
    assert.equal(BigInt(before) - BigInt(await tokenBalance(shares)), 1n);
  });
  await h.scenario('indexer-consistency', async () => {
    const targetBlock = Math.max(...Object.values(h.state.operations).map(op => op.blockNumber ?? 0));
    await h.until('indexer-checkpoint', async () => BigInt((await h.cli('indexer state')).last_block_number) >= BigInt(targetBlock), 300000);
    const proposal = await h.cli('proposal show', { dao, proposal: h.state.facts['setup-proposal'] });
    assert.equal(proposal.stateName, 'Processed'); assert(proposal.indexed);
    // proposal show verifies indexed calldata against the on-chain commitment.
    assert.equal(proposal.actions.length, setup.length);
    assert((await h.cli('navigator list', { dao })).items.length >= Object.keys(nav).length);
  }, true);
  await h.scenario('journal-recovery', async () => {
    for (const [id, record] of Object.entries(h.state.operations)) {
      const result = await h.cli('tx recover', { id }, record.wallet);
      assert.equal(result.outcome, 'mined'); assert.equal(result.record.hash, record.hash);
    }
  }, true);
  h.state.completedAt ??= new Date().toISOString(); h.state.lastVerifiedAt = new Date().toISOString(); await h.save();
  h.progress('completed', { scenarios: Object.keys(h.state.scenarios).length, transactions: Object.keys(h.state.operations).length, directory: h.directory });
}
