import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'ink';
import { stripVTControlCharacters } from 'node:util';
import { Screen } from '../dist/tui/app.js';
import { filterRows, windowRows, detailLines, proposalBadge } from '../dist/tui/model.js';
import { A } from './helpers.mjs';
const rows = Array.from({ length: 30 }, (_, i) => ({ key: String(i), label: `Proposal ${i}`, detail: 'Decide together with exact, visible outcomes', badge: i === 8 ? 'PASSED' : 'SUBMITTED', entity: {} }));
test('filtering is case insensitive and list windows retain the selected row', () => {
  assert.equal(filterRows(rows, 'proposal PASSED').length, 1);
  const visible = windowRows(rows, 29, 4); assert.equal(visible.items.length, 4); assert.equal(visible.items.at(-1).key, '29');
  assert.equal(windowRows([], -1, 0).selected, 0);
  assert.equal(proposalBadge({ processed: true, passed: true, action_failed: true }), 'ACTION FAILED');
  assert.equal(detailLines({ amount: 1n << 200n }).join('\n').includes((1n << 200n).toString()), true);
});
for (const [width, height] of [[60, 24], [80, 24], [110, 32], [160, 45], [50, 16]]) test(`workspace renders within ${width}×${height}`, () => {
  const output = stripVTControlCharacters(renderToString(React.createElement(Screen, {
    width, height, view: 'Proposals', data: { rows, metrics: [{ label: 'PROPOSALS', value: '30', detail: 'Ready to participate' }], source: 'ON CHAIN' }, selected: 8,
    search: '', searching: false, busy: '', network: 'orchard', dao: A, notice: '', updated: 1,
  }), { columns: width }));
  assert.match(output, /DAOShips/); assert.ok(output.split('\n').length <= height, `${output.split('\n').length} rows\n${output}`);
  if (width >= 58) { assert.match(output, /Proposal 8/); assert.match(output, /Quit/); }
  else assert.match(output, /Resize/);
});
