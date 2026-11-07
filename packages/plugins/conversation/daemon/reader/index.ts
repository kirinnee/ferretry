import type { RouteHandler, SocketAccept } from '@ferretry/kernel/contract';
import type { ToolHandler } from '@ferretry/kernel/manifest';
import type { ConversationApi, ConversationRefusal } from '../../contract/index.ts';

/**
 * PART B REGISTRATION POINT. Part b (reader, finder index, links, attachments, renders, search) replaces this stub
 * with the real `buildReader`: its routes, its sockets, its tools and the half of `ConversationApi` it owns. Part a's
 * `daemon/index.ts` merges whatever this returns into the one half the kernel loads, and fills every route this
 * returns nothing for with a 503 that says the part is not ready, never a missing route.
 */
export interface ReaderHalf {
  readonly routes: Readonly<Record<string, RouteHandler>>;
  readonly sockets: Readonly<Record<string, SocketAccept>>;
  /** The methods of `ConversationApi` part b owns. */
  readonly api: Pick<
    ConversationApi,
    | 'transcript'
    | 'logPage'
    | 'logSearch'
    | 'addAttachment'
    | 'attachment'
    | 'unlockAttachment'
    | 'relockAttachment'
    | 'saveRender'
    | 'renderMeta'
    | 'render'
    | 'searchWork'
    | 'related'
    | 'links'
    | 'previewLink'
    | 'keep'
  >;
  /** The agent tools it serves (`search_work`), by name. */
  readonly tools: Readonly<Record<string, ToolHandler>>;
}

const NOT_READY: ConversationRefusal = {
  code: 'plugin_unavailable',
  message: 'This part of Conversation is not ready yet.',
};
const refused = async () => ({ ok: false as const, error: NOT_READY });

export function buildReader(): ReaderHalf {
  return {
    routes: {},
    sockets: {},
    api: {
      transcript: refused,
      logPage: refused,
      logSearch: refused,
      addAttachment: refused,
      attachment: refused,
      unlockAttachment: refused,
      relockAttachment: refused,
      saveRender: refused,
      renderMeta: async () => undefined,
      render: async () => undefined,
      // read-scoped: none — a placeholder that shows nothing; part b replaces it with the real search.
      searchWork: async () => ({ cards: [], asks: [] }) as never,
      related: async () => ({ cards: [], asks: [] }) as never,
      links: async () => ({ conversations: [] }) as never,
      previewLink: refused,
      keep: async () => ({ kept: [], refused: [] }) as never,
    },
    tools: {},
  };
}
