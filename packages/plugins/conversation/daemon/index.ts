import { ApiError, type RouteHandler, type SocketAccept } from '@ferretry/kernel/contract';
import { implementDaemon } from '@ferretry/kernel/manifest';
import { type ConversationApi, LinkKept, QuestionSchema, SearchSources } from '../contract/index.ts';
import manifest from '../manifest.ts';
import { followFerretChanges } from './ferret-changes.ts';
import { buildConversationA } from './host.ts';
import { buildReading } from './reading.ts';
import { maskedBody } from './seams/masked-body.ts';

const unavailable =
  (sentence: string): RouteHandler =>
  async () => {
    throw new ApiError(503, sentence, 'plugin_unavailable');
  };

/**
 * The `guard: 'secrets'` routes that already build their answer inside their own redaction read (the transcript reads
 * and the work search), or serve bytes no mask may touch (an image, a render's payload). Every other such route is
 * wrapped in {@link maskedBody}.
 */
const SCRUBS_ITS_OWN_BODY: ReadonlySet<string> = new Set([
  'GET /v1/ferrets/:ferretId/logs',
  'GET /v1/ferrets/:ferretId/log-page',
  'GET /v1/ferrets/:ferretId/log-search',
  'GET /v1/ferrets/:ferretId/messages',
  'GET /v1/ferrets/:ferretId/transcript-images/:handle',
  'GET /v1/renders/:id',
  'GET /v1/search',
  'POST /v1/search/related',
]);

/** One handler per key the manifest declares: the one a part serves, or the fallback. */
function declared<K extends string, H>(
  keys: readonly K[],
  served: Readonly<Record<string, H>>,
  fallback: (key: K) => H,
): Record<K, H> {
  const table = {} as Record<K, H>;
  for (const key of keys) table[key] = served[key] ?? fallback(key);
  return table;
}

/**
 * Conversation's daemon half (§2.3): what you say to a ferret and what it says back. Part a (this file's `host.ts`)
 * owns messages, the queue, turns, questions and drafts; part b (`./reading.ts`: reader, links, attachments, renders, search) is built over the same ports. A declared route that
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
    const b = buildReading({
      kernel: ctx.kernel,
      ferrets: ctx.needs.ferrets,
      asks: ctx.needs.asks,
      onKept: (ferret, link) => ctx.kernel.events.publish(LinkKept, { ferret, link }),
      workSources: () => ctx.hooks.contributions(SearchSources).map(contribution => contribution.item),
    });
    ctx.kernel.lifecycle.onStop(() => {
      a.stop();
      b.stop();
    });

    const served = { ...a.routes, ...b.routes };
    const routes = declared(
      manifest.actions.routes.map(route => route.key),
      Object.fromEntries(
        manifest.actions.routes.flatMap(route => {
          const handler = served[route.key];
          if (handler === undefined) return [];
          const masks = route.guard === 'secrets' && !SCRUBS_ITS_OWN_BODY.has(route.key);
          return [[route.key, masks ? maskedBody(ctx.kernel.redaction, handler) : handler]];
        }),
      ),
      () => unavailable('This part of Conversation is not ready yet.'),
    );
    const sockets = declared(
      manifest.actions.sockets.map(socket => socket.key),
      a.sockets,
      (key): SocketAccept => {
        throw new Error(`Conversation declares the socket ${key} and builds none`);
      },
    );

    const api: ConversationApi = { ...b.api, ...a.api };

    return {
      routes,
      sockets,
      tools: {
        search_work: b.tools.search_work,
      },
      provides: { conversation: api },
      hooks: {
        'ask.sources:question': { schema: QuestionSchema, title: 'Question', form: true },
        'sitrep.lines': () => [{ id: 'conversation', item: a.sitrep }],
        // A ferret stopped or is gone: its unlocked attachments are zeroed first; every change is a turn look.
        'ferret.changed': followFerretChanges({
          release: ferret => b.release(ferret),
          look: (ferret, phase) => a.turns.look(ferret, phase),
          forget: ferret => a.turns.forget(ferret),
          warn: message => ctx.kernel.log.warn(message),
        }),
      },
      subscribers: {
        // An ask was answered: the draft of its item goes with it (a chat reply keeps the draft).
        'asks.answered': async payload => {
          await a.onAskAnswered(payload);
        },
      },
    };
  },
});
