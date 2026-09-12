import { Interface } from 'quais';
import { CONTRACT_ABIS, assertActionSucceeded, parseContractEvents, type Receipt } from '@daoships/sdk';
import { CliError } from './values.js';

const dao = new Interface(CONTRACT_ABIS.DAOShip), vault = new Interface(CONTRACT_ABIS.QuaiVault), token = new Interface(CONTRACT_ABIS.SharesERC20);
const same = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
/** Status 1 proves the outer call; some contracts report inner failure in events. */
export function assertBusinessOutcome(tx: { from: string; to: string; data: string }, receipt: Receipt): void {
  const selector = tx.data.slice(0, 10);
  if (selector === dao.getFunction('processProposal')!.selector) {
    const args = dao.decodeFunctionData('processProposal', tx.data);
    assertActionSucceeded(receipt, tx.to, Number(args[0]));
  }
  if (['executeTransaction', 'execTransactionFromModule(address,uint256,bytes)', 'execTransactionFromModule(address,uint256,bytes,uint8)', 'execTransactionFromModuleReturnData'].some(name => vault.getFunction(name)?.selector === selector)) {
    const failed = parseContractEvents(receipt, 'QuaiVault', tx.to, 'TransactionFailed').length || parseContractEvents(receipt, 'QuaiVault', tx.to, 'ExecutionFromModuleFailure').length;
    if (failed) throw new CliError('ACTION_FAILED', 'The vault transaction was mined, but its inner action failed.', {}, 3);
    if (!parseContractEvents(receipt, 'QuaiVault', tx.to, 'TransactionExecuted').length && !parseContractEvents(receipt, 'QuaiVault', tx.to, 'ExecutionFromModuleSuccess').length) throw new CliError('MISSING_EVENT', 'The receipt does not confirm successful vault execution.', {}, 3);
  }
  const method = ['transfer', 'transferFrom', 'approve', 'delegate'].find(name => token.getFunction(name)?.selector === selector);
  if (!method) return;
  const args = token.decodeFunctionData(method, tx.data);
  let matched: boolean;
  if (method === 'delegate') matched = parseContractEvents(receipt, 'SharesERC20', tx.to, 'DelegateChanged').some(e => same(e.args.delegator, tx.from) && same(e.args.toDelegate, args[0]));
  else if (method === 'approve') matched = parseContractEvents(receipt, 'SharesERC20', tx.to, 'Approval').some(e => same(e.args.owner, tx.from) && same(e.args.spender, args[0]) && e.args.value === args[1]);
  else {
    const [from, to, amount] = method === 'transfer' ? [tx.from, args[0], args[1]] : [args[0], args[1], args[2]];
    matched = parseContractEvents(receipt, 'SharesERC20', tx.to, 'Transfer').some(e => same(e.args.from, from) && same(e.args.to, to) && e.args.value === amount);
  }
  if (!matched) throw new CliError('MISSING_EVENT', 'The receipt does not confirm the requested token change.', {}, 3);
}
