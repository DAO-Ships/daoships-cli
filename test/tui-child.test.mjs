import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnAction } from '../dist/tui/app.js';
import { findCommand } from '../dist/commands.js';
import { context, A, HASH } from './helpers.mjs';

test('TUI child accepts requests larger than OS argument limits without loading a signer', async t => {
  const ctx = await context(t), data = '0x' + 'ab'.repeat(100000);
  const result = await spawnAction(ctx, findCommand('proposal encode'), { actions: [{ to: A, data, value: '0' }] }, { transaction: { from: A }, reviewHash: HASH }, 'large-preview', ctx.signal);
  assert.equal(result.actions[0].data, data); assert.equal(ctx.store.records().length, 0);
});
