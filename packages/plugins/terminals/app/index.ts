import { implementApp } from '@ferretry/kernel/manifest';
import { createElement } from 'react';
import manifest from '../manifest.ts';
import {
  browserTerminalDeckHost,
  SessionTerminalDeck,
  type SessionTerminalDeckProps,
} from './components/session-terminal-deck.tsx';
import { TerminalSlotsSettings } from './features/settings/terminal-slots-settings.tsx';
import { pluginTerminalDeckDependencies, pluginTerminalSlotsClient } from './lib/plugin-client.ts';

/**
 * The daemon a half's views speak to. The shell builds one half per daemon (§9.6) and hands it that daemon's own
 * client, so the views' `connection` only names "this half's daemon": it keys their state and is handed back to the
 * dependencies, which ignore it and ride the client.
 */
const THIS_DAEMON = { daemonId: 'this-daemon' } as unknown as SessionTerminalDeckProps['connection'];

/**
 * The Terminals app half (§2.3): the terminal deck in a ferret's side pane (today's `session-terminal-deck.tsx`),
 * Settings › Terminals (today's `terminal-slots-settings.tsx`) and the `%terminal:` reference chip. Each view is
 * today's component, unchanged, given dependencies over the shell's per-daemon client (`lib/plugin-client.ts`).
 */
export default implementApp(manifest, {
  build: ({ client }) => {
    const dependencies = pluginTerminalDeckDependencies(client, browserTerminalDeckHost());
    const slots = pluginTerminalSlotsClient(client);
    return {
      panels: {
        terminals: ({ subject }) =>
          subject === undefined
            ? null
            : createElement(SessionTerminalDeck, {
                connection: THIS_DAEMON,
                scope: { daemonId: THIS_DAEMON.daemonId, sessionId: subject },
                dependencies,
              }),
      },
      settings: {
        terminals: () =>
          createElement(TerminalSlotsSettings, { connection: THIS_DAEMON, createClient: async () => slots }),
      },
      renderers: {
        'reference:%terminal': ({ value }) =>
          createElement(
            'code',
            { className: 'kt-reference kt-reference--terminal' },
            `%terminal:${typeof value === 'string' ? value : ''}`,
          ),
      },
    };
  },
});
