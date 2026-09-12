import React from 'react';
import { render } from 'ink';
import { App } from '../../dist/tui/app.js';
import { Context } from '../../dist/context.js';

let active;
const open = async () => {
  const previous = active;
  active = await Context.open({ configDir: process.argv[2] });
  // Public discovery is deterministic; wallet commands use the real binary and keystore.
  Object.defineProperty(active, 'indexer', { value: { list: async () => ({ items: [], nextOffset: null }) } });
  previous?.close(); return active;
};
const app = render(React.createElement(App, { initialContext: await open(), reconfigure: open }), { interactive: true, alternateScreen: true, exitOnCtrlC: false });
try { await app.waitUntilExit(); } finally { app.unmount(); active.close(); }
