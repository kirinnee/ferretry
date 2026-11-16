import { ApiError, type RouteHandler, type SocketAccept } from '@ferretry/kernel/contract';
import { type DaemonHalf, implementDaemon, perNeeder } from '@ferretry/kernel/manifest';
import { type HarnessGate, HARNESS_OPEN } from '@ferretry/core-mailbox/contract';
import { type ConversationApi, conversationFor } from '../contract/index.ts';
import manifest from '../manifest.ts';
import { PDF_WORKER_URL } from './attachments/adapters/decrypt-pdf.ts';
import { composeConversation } from './features/compose.ts';
import type { ConversationContext } from './features/types.ts';
import features from './generated/features.ts';
import { addressedByCallsign } from './seams/ferret-address.ts';
import { maskedBody } from './seams/masked-body.ts';

type Half = DaemonHalf<typeof manifest>;

const unavailable =
  (sentence: string): RouteHandler =>
  async () => {
    throw new ApiError(503, sentence, 'plugin_unavailable');
  };

/** One handler per key the manifest declares: the one a feature serves, or the fallback. */
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
 * Conversation's daemon half (§2.3): what you say to a ferret and what it says back. Each feature lives in its own file
 * under `./features/` (`<feature>.feature.ts`, listed by the generator into `./generated/features.ts`) and adds its own
 * routes, sockets, tools, hooks, subscribers and port members; this file composes them and keeps what is shared by all:
 * the callsign addressing and the secret mask every `guard: 'secrets'` route gets (unless its feature scrubs its own
 * body). A declared route that no feature serves yet answers 503 with its sentence, never a missing route.
 */
export const conversationDaemon = (gate: HarnessGate) =>
  implementDaemon(manifest, {
    // The PDF unlock thread: `fyd --check` starts and stops it, so a binary that did not carry it is seen at once.
    workers: { 'pdf-decrypt': PDF_WORKER_URL },
    build: ctx => {
      const context: ConversationContext = {
        daemon: ctx,
        kernel: ctx.kernel,
        ferrets: ctx.needs.ferrets,
        asks: ctx.needs.asks,
        hooks: ctx.hooks,
        mailbox: ctx.needs.mailbox,
        gate,
        clock: { now: () => ctx.kernel.clock.now() },
        late: {},
      };
      const served = composeConversation(features, context);
      ctx.kernel.lifecycle.onStop(served.stop);

      const routes = declared(
        manifest.actions.routes.map(route => route.key),
        Object.fromEntries(
          manifest.actions.routes.flatMap(route => {
            const declaredHandler = served.routes[route.key];
            if (declaredHandler === undefined) return [];
            // A path that names a ferret takes its callsign as well as its id.
            const handler = route.key.includes(':ferretId')
              ? addressedByCallsign(ctx.needs.ferrets, declaredHandler)
              : declaredHandler;
            const masks = route.guard === 'secrets' && !served.scrubsItsOwnBody.has(route.key);
            return [
              [
                route.key,
                masks ? maskedBody(ctx.kernel.redaction, handler, served.verbatimFields[route.key]) : handler,
              ],
            ];
          }),
        ),
        () => unavailable('This part of Conversation is not ready yet.'),
      );
      const sockets = declared(
        manifest.actions.sockets.map(socket => socket.key),
        served.sockets,
        (key): SocketAccept => {
          throw new Error(`Conversation declares the socket ${key} and builds none`);
        },
      );

      // What the features serve is keyed by strings, so the manifest's own key types are asserted here and the key sets
      // are pinned by `tests/unit/daemon/features.test.ts` (and the kernel refuses a declared tool, hook or subscriber
      // nobody serves when it boots). Every member of the port is some feature's.
      const api = served.port as ConversationApi;

      return {
        routes,
        sockets,
        tools: served.tools as Half['tools'],
        provides: { conversation: perNeeder(needer => conversationFor(needer.id, api)) },
        hooks: served.hooks as Half['hooks'],
        subscribers: served.subscribers as Half['subscribers'],
      };
    },
  });

export default conversationDaemon(HARNESS_OPEN);
