import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { stripVTControlCharacters } from 'node:util';
import { Interface } from 'quais';
import { CONTRACT_ABIS } from '@daoships/sdk';
import { App } from '../dist/tui/app.js';
import { context, override, B, prepared } from './helpers.mjs';

test('keyboard flow selects a DAO, searches commands and opens guided navigator creation', async t => {
  const ctx = await context(t), stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
  Object.assign(stdin, { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  Object.assign(stdout, { isTTY: true, columns: 112, rows: 34 });
  let output = ''; stdout.on('data', c => { output += c; }); stderr.on('data', () => {});
  const daoInterface = new Interface(CONTRACT_ABIS.DAOShip);
  override(ctx, { provider: { call: async request => daoInterface.encodeFunctionResult(daoInterface.parseTransaction(request).fragment, [7n]) }, indexer: { list: async () => ({ items: [{ id: B, name: 'Test collective' }], nextOffset: null }), listNavigators: async () => ({ items: [], nextOffset: null }) },
    chain: { getDao: async () => ({ ...prepared().checkedAt, checkedAt: prepared().checkedAt, address: B, votingPeriod: 60n, gracePeriod: 0n, quorumPercent: 5000n, proposalOffering: 0n }) } });
  const app = render(React.createElement(App, { initialContext: ctx, reconfigure: async () => ctx }), { stdin, stdout, stderr, exitOnCtrlC: false });
  t.after(() => { app.unmount(); stdin.destroy(); stdout.destroy(); stderr.destroy(); });
  const text = () => stripVTControlCharacters(output);
  const waitFor = async pattern => {
    const deadline = Date.now() + 2500;
    while (!pattern.test(text()) && Date.now() < deadline) await delay(20);
    assert.match(text(), pattern);
  };
  const key = async value => { output = ''; stdin.write(value); await delay(80); };
  await waitFor(/Test collective/);
  await key('\r'); assert.equal(ctx.config.daos.orchard, B); assert.match(text(), /Overview/);
  await key('\x0b'); assert.match(text(), /Go anywhere/); assert.match(text(), /status/);
  await key('network list'); assert.match(text(), /network list/);
  await key('\r'); assert.match(text(), /network list/); assert.match(text(), /orchard/);
  await key('\x1b'); await key('6'); await key('+'); assert.match(text(), /navigator deploy/); assert.match(text(), /OnboarderNavigator/);
  await key('\r'); assert.match(text(), /Dao Ship/); assert.match(text(), /STEP 1 OF/);
  await key('\x1b'); await key('2'); await key('a'); await key('navigators(address)'); await key('\r');
  await key(B); await key('\r'); await waitFor(/"7"/); assert.match(text(), /contract read/); assert.doesNotMatch(text(), /Unknown input field/);
  await key('\x1b'); await key('q'); await app.waitUntilExit();
});
