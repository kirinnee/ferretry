import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { accountsTab } from './surfaces.tsx';

/**
 * Git accounts' app half, built per machine with that machine's client: the GitHub accounts settings tab (list the
 * connected accounts, connect one by the device flow after the consent words, remove one). Only logins, key titles and
 * the short user code are ever drawn; no token reaches a browser.
 */
export default implementApp(manifest, {
  build: ({ client }) => ({ settings: { accounts: accountsTab(client) } }),
});
