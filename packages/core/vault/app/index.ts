import { provideToShell } from '@ferretry/app';
import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { InputModalHost } from './features/input/input-modal.tsx';
import { askFromUrl, tappedAsks } from './lib/input-modal.ts';
import { inputRenderer, secretsTab } from './surfaces.tsx';

/**
 * Vault's app half (§2.3), built per machine with that machine's client: the Secrets settings tab (create, replace and
 * delete; only names and instants shown) and the `ask:input` card (the owner's form for a value a ferret asked for).
 *
 * It also gives the shell the input modal (`shell.background`, once per paired machine at the frame root: the pending
 * sign-in cards, one at a time) and hears a notification tap (`shell.notificationOpened`): a tap that names an ask
 * (`?ask=A3`) opens exactly that card.
 */
export default provideToShell(
  implementApp(manifest, {
    build: ({ client }) => ({
      settings: { secrets: secretsTab(client) },
      renderers: { 'ask:input': inputRenderer(client) },
    }),
  }),
  {
    background: { 'input-modal': InputModalHost },
    notificationOpened: ({ daemon }, { url }) => {
      const ask = askFromUrl(url);
      if (ask !== undefined) tappedAsks.want(daemon, ask);
    },
  },
);
