import { provideToShell } from '@ferretry/app';
import { implementApp } from '@ferretry/kernel/manifest';
import { createElement } from 'react';
import manifest from '../manifest.ts';
import { ConnectPanel } from './features/connect/connect-panel.tsx';
import { accountsTab } from './surfaces.tsx';

/**
 * Projects' hook (`PROJECTS_CONNECT_ACCOUNT_HOOK`), given by name: the name and the shape are the whole agreement. The
 * Create-a-project flow draws THIS card, so connecting inside it is the same consent words, code card, quiet polls and
 * passkey press as the settings tab, not a copy of them.
 */
const CONNECT_ACCOUNT_HOOK = 'projects.connect-account';

/**
 * Git accounts' app half, built per machine with that machine's client: the GitHub accounts settings tab (list the
 * connected accounts, connect one by the device flow after the consent words, remove one), and the connect card the
 * Create-a-project flow mounts. Only logins, key titles and the short user code are ever drawn; no token reaches a
 * browser.
 */
export default provideToShell(
  implementApp(manifest, {
    build: ({ client }) => ({ settings: { accounts: accountsTab(client) } }),
  }),
  {
    hooks: {
      // Built once per daemon over this plugin's own client, so `panel` is one component for as long as that client lasts.
      [CONNECT_ACCOUNT_HOOK]: ({ client }) => ({
        panel: ({
          connected,
          onConnected,
        }: {
          readonly connected: number;
          readonly onConnected: (id: string) => void;
        }) => createElement(ConnectPanel, { client, connected, onConnected }),
      }),
    },
  },
);
