import { audit, cap } from '@ferretry/core-gate/contract';
import { VaultPort } from '@ferretry/core-vault/contract';
import { definePlugin, route, settingsTab, tool } from '@ferretry/kernel/manifest';
import {
  SEARCH_CONFIG,
  SEARCH_LEDGER_STATE,
  SEARCH_PROVIDER_IDS,
  SEARCH_PROVIDERS,
  WebSearchInputSchema,
} from './contract/index.ts';

/**
 * Search (§2.3): `web_search` for ferrets whose runtime has no search tool of its own (an open-weight model behind
 * Claude Code, say). The owner picks ONE of six providers and adds their own key; **it is off until a key is named**,
 * and the tool then answers "No search provider set up: Settings › Web search".
 *
 * Keys are Vault secrets by NAME, placed on the request by the kernel and only to the provider's one host (the table
 * in `contract/providers.ts` is both lists below). `search.yaml` names the picked provider's key as `${secret:NAME}`;
 * an agent's write that adds that line is held for the owner. Searches are capped per day (`dailyCap`, default 200),
 * its own cap and outside the creative-tools spend cap.
 */
export default definePlugin({
  id: 'search',
  title: 'Web search',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['view', 'command'],
  words: [{ word: 'search provider', means: 'the service that answers a web search', insteadOf: ['search engine'] }],

  // The Settings screen saves a pasted key through the Vault's own secret route (`POST /v1/secrets`), so the Vault is a need.
  needs: { vault: VaultPort },

  actions: {
    routes: [
      route('GET /v1/web-search', {
        minimum: 'operator',
        caller: 'any',
        capability: cap('secrets', 'use'),
        noStore: true,
        audit: { skip: 'a read of the provider, the cap and today’s count; it never opens the vault' },
        guard: { none: 'names, numbers and fixed sentences; no key and no provider body' },
      }),
      route('PUT /v1/web-search/setup', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('secrets', 'configure'),
        noStore: true,
        audit: audit('secrets.changed'),
        guard: { none: 'names a provider and a reference to its key, never a value' },
      }),
      route('POST /v1/web-search/test', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('secrets', 'use'),
        noStore: true,
        // A Test spends one search on the owner's account; the kernel writes its own `secrets.used` line for the send.
        audit: { skip: 'the kernel records the key use as secrets.used, with the secret’s name and the host' },
        guard: { none: 'a code and one fixed sentence; never the provider body' },
      }),
    ],
    agentTools: [
      tool('web_search', {
        minimum: 'authenticated',
        caller: 'any',
        audit: { skip: 'the kernel records each key use as secrets.used; the daily ledger counts the calls' },
        guard: { none: 'a provider’s search results (titles, links, short snippets); no pane, page or vault text' },
        summary:
          'Search the web. For runtimes without a search tool of their own; if you have one, use it instead. Returns titles, links and short snippets; off until the owner sets a provider in Settings › Web search.',
        input: WebSearchInputSchema,
      }),
    ],
  },

  ui: {
    settings: [
      settingsTab('search', { icon: 'search', group: 'advanced', label: 'Web search', order: 71, scope: 'machine' }),
    ],
  },

  data: {
    state: [SEARCH_LEDGER_STATE],
    config: [SEARCH_CONFIG],
  },

  permissions: {
    // Each key rides only to its own provider's host; both lists are the provider table.
    network: SEARCH_PROVIDER_IDS.map(id => SEARCH_PROVIDERS[id].host),
    secrets: SEARCH_PROVIDER_IDS.map(id => SEARCH_PROVIDERS[id].secretName),
  },
});
