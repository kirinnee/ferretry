import { implementApp } from '@ferretry/kernel/manifest';
import { createElement } from 'react';
import manifest from '../manifest.ts';
import { SessionTerminalDeck } from './components/session-terminal-deck.tsx';
import { TerminalSlotsSettings } from './features/settings/terminal-slots-settings.tsx';
import { terminalDeckDependencies } from './lib/deck-dependencies.ts';

/**
 * The Terminals app half (§2.3): the terminal deck in a ferret's side pane (today's `session-terminal-deck.tsx`),
 * Settings › Terminals (today's `terminal-slots-settings.tsx`) and the `%terminal:` reference chip. The shell builds
 * one half per daemon and hands it that daemon's own client, which every view rides: the deck's list, create, rename,
 * close and viewer stream, and the settings tab's holders and cleanup.
 */
export default implementApp(manifest, {
  build: ({ client }) => {
    const dependencies = terminalDeckDependencies(client);
    return {
      panels: {
        terminals: ({ subject }) =>
          subject === undefined
            ? null
            : createElement(SessionTerminalDeck, { scope: { sessionId: subject }, dependencies }),
      },
      settings: {
        terminals: () => createElement(TerminalSlotsSettings, { client }),
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
