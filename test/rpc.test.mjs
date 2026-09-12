import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { EndpointProvider } from '../dist/rpc.js';
import { context } from './helpers.mjs';

async function server(t, handler) {
  const service = createServer(handler); service.listen(0, '127.0.0.1'); await once(service, 'listening');
  t.after(() => { service.closeAllConnections(); service.close(); }); return `http://127.0.0.1:${service.address().port}/cyprus1`;
}
test('endpoint URLs stay exact and every getNetwork probes the actual chain', async t => {
  const calls = []; let chain = '0x3a98';
  const url = await server(t, async (req, res) => {
    let data = ''; for await (const chunk of req) data += chunk;
    const raw = JSON.parse(data), batch = Array.isArray(raw), requests = batch ? raw : [raw];
    const replies = requests.map(r => { calls.push({ path: req.url, method: r.method }); return { id: r.id, jsonrpc: '2.0', result: chain }; });
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(batch ? replies : replies[0]));
  });
  const provider = new EndpointProvider(url, 15000, 1000); t.after(() => provider.destroy());
  assert.equal((await provider.getNetwork()).chainId, 15000n); chain = '0x9';
  await assert.rejects(provider.getNetwork(), { code: 'CHAIN_MISMATCH' });
  assert.ok(calls.every(c => c.path === '/cyprus1' && c.method === 'quai_chainId')); assert.equal(calls.length, 2);
});
test('unresponsive RPC returns within the command deadline', async t => {
  const url = await server(t, () => {}), ctx = await context(t, { rpc: url, timeout: 80 });
  const before = performance.now(); await assert.rejects(ctx.assertNetwork()); assert.ok(performance.now() - before < 1500);
});
