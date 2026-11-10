import { ApiError, type RouteHandler, type SocketAccept } from '@ferretry/kernel/contract';
import { implementDaemon, perNeeder } from '@ferretry/kernel/manifest';
import {
  type ConversationApi,
  conversationFor,
  LinkKept,
  QuestionSchema,
  ReferenceCatalog,
  SearchSources,
} from '../contract/index.ts';
import manifest from '../manifest.ts';
import { PDF_WORKER_URL } from './attachments/adapters/decrypt-pdf.ts';
import { openingAttachmentsSource } from './attachments/adapters/opening-attachments.ts';
import { followFerretChanges, followFerretStopping } from './ferret-changes.ts';
import { buildConversationA } from './host.ts';
import { type HarnessGate, HARNESS_OPEN } from './harness-seam.ts';
import { hypermediaLaunchEnvironment } from './hypermedia/lib/launch.ts';
import { buildReading } from './reading.ts';
import { maskedBody } from './seams/masked-body.ts';
import { referenceCatalogRoute } from './references/catalog.ts';

const unavailable =
  (sentence: string): RouteHandler =>
  async () => {
    throw new ApiError(503, sentence, 'plugin_unavailable');
  };

/**
 * The `guard: 'secrets'` routes that already build their answer inside their own redaction read (the transcript reads
 * and the work search), or serve bytes no mask may touch (a transcript image). Every other such route is wrapped in
 * {@link maskedBody}.
 */
const SCRUBS_ITS_OWN_BODY: ReadonlySet<string> = new Set([
  'GET /v1/ferrets/:ferretId/logs',
  'GET /v1/ferrets/:ferretId/log-page',
  'GET /v1/ferrets/:ferretId/log-search',
  'GET /v1/ferrets/:ferretId/messages',
  'GET /v1/ferrets/:ferretId/transcript-images/:handle',
  'GET /v1/search',
  'POST /v1/search/related',
]);

/**
 * Fields a masked route serves as they are stored, beyond bytes and digests. A render's `payload` is the picture
 * itself, named by its sha256 (its id and its etag): a mask would change what that id names and break the picture, and
 * today never masked renders. Its `meta` (the alt text) is masked, exactly as `GET /v1/renders/:id/meta` masks it.
 */
const VERBATIM_FIELDS: Readonly<Record<string, readonly string[]>> = { 'GET /v1/renders/:id': ['payload'] };

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
export const conversationDaemon = (gate: HarnessGate) =>
  implementDaemon(manifest, {
    // The PDF unlock thread: `fyd --check` starts and stops it, so a binary that did not carry it is seen at once.
    workers: { 'pdf-decrypt': PDF_WORKER_URL },
    build: ctx => {
      const a = buildConversationA({
        kernel: ctx.kernel,
        ferrets: ctx.needs.ferrets,
        asks: ctx.needs.asks,
        hooks: ctx.hooks,
        gate,
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

      const served: Readonly<Record<string, RouteHandler | undefined>> = {
        ...a.routes,
        ...b.routes,
        'GET /v1/ferrets/:ferretId/references': referenceCatalogRoute({
          providerOf: prefix => ctx.hooks.provider(ReferenceCatalog, prefix),
          ferrets: ctx.needs.ferrets,
        }),
      };
      const routes = declared(
        manifest.actions.routes.map(route => route.key),
        Object.fromEntries(
          manifest.actions.routes.flatMap(route => {
            const handler = served[route.key];
            if (handler === undefined) return [];
            const masks = route.guard === 'secrets' && !SCRUBS_ITS_OWN_BODY.has(route.key);
            return [
              [route.key, masks ? maskedBody(ctx.kernel.redaction, handler, VERBATIM_FIELDS[route.key]) : handler],
            ];
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
        provides: { conversation: perNeeder(needer => conversationFor(needer.id, api)) },
        hooks: {
          'ask.sources:question': { schema: QuestionSchema, title: 'Question', form: true },
          // What a launch says about hypermedia: only a switch the owner set, so a ferret with none keeps its mode default.
          'launch.parts': () => [
            {
              id: 'conversation-hypermedia',
              item: {
                parts: async spec => [
                  { kind: 'env' as const, env: hypermediaLaunchEnvironment(await a.hypermediaRecorded(spec.ferret)) },
                ],
              },
            },
          ],
          // The files a start was given (`fy start -f`): decoded, bounded and worded here, written and appended by Ferrets.
          // The one provider of this security-path hook (`takers: ['conversation']`), under its one key.
          'opening.attachments:opening': openingAttachmentsSource(),
          'sitrep.lines': () => [{ id: 'conversation', item: a.sitrep }],
          // A stop is being attempted: the unlocked attachments are zeroed before it can fail.
          'ferret.stopping': followFerretStopping({ release: ferret => b.release(ferret) }),
          // A ferret stopped or is gone: its unlocked attachments are zeroed first; every change is a turn look.
          'ferret.changed': followFerretChanges({
            release: ferret => b.release(ferret),
            look: (ferret, phase) => a.turns.look(ferret, phase),
            forget: ferret => a.turns.forget(ferret),
            withdrawQuestion: ferret =>
              void a
                .withdrawQuestion(ferret)
                .catch((error: unknown) =>
                  ctx.kernel.log.warn(`conversation could not withdraw the question of ${ferret}: ${String(error)}`),
                ),
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

export default conversationDaemon(HARNESS_OPEN);
