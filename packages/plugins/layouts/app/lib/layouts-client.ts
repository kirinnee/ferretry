/**
 * LAYOUTS' OWN CLIENT, for the Layout tab: every call is a route key of this plugin's manifest through the half's own
 * plugin client (hash-guarded, one daemon), and every answer is parsed with the contract's schema before the tab sees
 * it — an answer that does not parse is a failed read, never a half-drawn screen.
 */
import type { PluginClient } from '@ferretry/kernel/manifest';
import {
  type CurrentLayout,
  CurrentLayoutSchema,
  type LayoutList,
  LayoutListSchema,
  LayoutsChanged,
} from '../../contract/index.ts';

/** What the tab reads: the layout in use (the owner's changes applied) and what can be switched to. */
export interface LayoutsRead {
  readonly current: CurrentLayout;
  readonly list: LayoutList;
}

export interface LayoutsClient {
  read(): Promise<LayoutsRead>;
  /** `fy layout set <path> <value>`: one key, as the word or the comma list the verb takes. */
  set(path: string, value: string): Promise<void>;
  /** `fy layout use <id>`. */
  switchLayout(layout: string): Promise<void>;
  /** `fy theme use <id>`. */
  switchTheme(theme: string): Promise<void>;
  /** `fy layout reset`: drop the owner's changes and use the built-in default. */
  reset(): Promise<void>;
  /** `fy layout save <id>`: keep the layout in use as a new, shareable layout item. */
  save(id: string): Promise<void>;
  /** Remove one saved layout. */
  remove(id: string): Promise<void>;
  /** Calls `listener` after every change anyone made to the layout or theme (`layouts.changed`). */
  onChanged(listener: () => void): () => void;
}

export function layoutsClient(client: PluginClient): LayoutsClient {
  return {
    read: async () => ({
      current: CurrentLayoutSchema.parse(await client.call('GET /v1/layouts/current')),
      list: LayoutListSchema.parse(await client.call('GET /v1/layouts')),
    }),
    set: async (path, value) => {
      await client.call('PATCH /v1/layouts/current', { body: { changes: [{ path, value }] } });
    },
    switchLayout: async layout => {
      await client.call('PUT /v1/layouts/current', { body: { layout } });
    },
    switchTheme: async theme => {
      await client.call('PUT /v1/layouts/theme', { body: { theme } });
    },
    reset: async () => {
      await client.call('POST /v1/layouts/reset');
    },
    save: async id => {
      await client.call('POST /v1/layouts', { body: { id } });
    },
    remove: async id => {
      await client.call('DELETE /v1/layouts/:layoutId', { params: { layoutId: id } });
    },
    onChanged: listener => client.subscribe(LayoutsChanged, () => listener()),
  };
}
