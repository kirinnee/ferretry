import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { inputRenderer, secretsTab } from './surfaces.tsx';

/**
 * Vault's app half (§2.3), built per machine with that machine's client: the Secrets settings tab (create, replace and
 * delete; only names and instants shown) and the `ask:input` card (the owner's form for a value a ferret asked for).
 */
export default implementApp(manifest, {
  build: ({ client }) => ({
    settings: { secrets: secretsTab(client) },
    renderers: { 'ask:input': inputRenderer(client) },
  }),
});
