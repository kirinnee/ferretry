import { ApiError, type RouteHandler, type SocketAccept } from '@ferretry/kernel/contract';
import { implementDaemon } from '@ferretry/kernel/manifest';
import { AskSources } from '@ferretry/core-asks/contract';
import { SitrepLines } from '@ferretry/core-ferrets/contract';
import { type ConversationApi, QuestionSchema } from '../contract/index.ts';
import manifest from '../manifest.ts';
import { buildConversationA } from './host.ts';
// PART B REGISTRATION: its routes, sockets, tools and the half of `ConversationApi` it owns.
import { buildReader } from './reader/index.ts';

type Half = ReturnType<typeof implementDaemon<typeof manifest>>;
type Build = NonNullable<Half['build']>;
type Built = ReturnType<Build>;

const unavailable =
  (sentence: string): RouteHandler =>
  async () => {
    throw new ApiError(503, sentence, 'plugin_unavailable');
  };

/**
 * Conversation's daemon half (§2.3): what you say to a ferret and what it says back. Part a (this file's `host.ts`)
 * owns messages, the queue, turns, questions and drafts; part b registers through `./reader`. A declared route that
 * neither part serves yet answers 503 with its sentence, never a missing route.
 */
export default implementDaemon(manifest, {
  build: ctx => {
    const a = buildConversationA({
      kernel: ctx.kernel,
      ferrets: ctx.needs.ferrets,
      asks: ctx.needs.asks,
      hooks: ctx.hooks,
    });
    const b = buildReader();
    ctx.kernel.lifecycle.onStop(() => a.stop());

    const routes: Record<string, RouteHandler> = { ...a.routes, ...b.routes };
    for (const declared of manifest.actions.routes)
      routes[declared.key] ??= unavailable('This part of Conversation is not ready yet.');
    const sockets: Record<string, SocketAccept> = { ...a.sockets, ...b.sockets };

    const api: ConversationApi = { ...b.api, ...a.api };

    return {
      routes,
      sockets,
      tools: {
        search_work: b.tools.search_work ?? (async () => ({ ok: false, error: 'Search is not ready yet.' })),
      },
      provides: { conversation: api },
      hooks: {
        'ask.sources:question': { schema: QuestionSchema, title: 'Question', form: true },
        'sitrep.lines': () => [{ id: 'conversation', item: a.sitrep }],
      },
      subscribers: {
        // An ask was answered: the draft of its item goes with it (a chat reply keeps the draft).
        'asks.answered': async (payload: { readonly askId: string }) => {
          await a.onAskAnswered(payload.askId);
        },
      },
    } as unknown as Built;
  },
});

// Kept so the contract imports above are the ones the manifest declares.
void AskSources;
void SitrepLines;
