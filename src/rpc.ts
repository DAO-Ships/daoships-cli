import { Network, Shard } from 'quais';
import { DaoShipsProvider } from '@daoships/sdk';
import { CliError } from './values.js';

/** Single Cyprus-1 endpoint. SDK still owns transaction/block normalization. */
export class EndpointProvider extends DaoShipsProvider {
  constructor(url: string, private expectedChainId: number, timeout: number) {
    // Avoid upstream URL discovery and its console-writing background retry loop.
    // Every getNetwork() below probes the actual chain, including SDK signing guards.
    super(url, expectedChainId, { usePathing: false, staticNetwork: true });
    for (const connection of this.connect) connection.timeout = timeout;
  }
  override async getNetwork(): Promise<Network> {
    const raw: unknown = await this.send('quai_chainId', [], Shard.Cyprus1);
    if (typeof raw !== 'string' || !/^0x[\da-f]{1,16}$/i.test(raw)) throw new CliError('INVALID_RESPONSE', 'RPC returned an invalid chain ID.', {}, 1);
    if (BigInt(raw) !== BigInt(this.expectedChainId)) throw new CliError('CHAIN_MISMATCH', 'RPC network differs from the selected network.', {}, 3);
    return Network.from(this.expectedChainId);
  }
}
