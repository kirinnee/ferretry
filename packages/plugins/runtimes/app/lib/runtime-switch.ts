/**
 * The in-place switch of a running ferret's model, reasoning level or fast mode, and the read of its session
 * document, over the daemon's client. Pure over an injected client; the pickers in `components/runtime-controls.tsx`
 * only see `RuntimeControlApi`.
 */

import { type FerretSummary, FerretSummarySchema } from '@ferretry/core-ferrets/contract';
import type { RuntimesClient } from './client.ts';
import type { RuntimeSessionView } from './session-view.ts';

/** What the component asks a daemon to do. The host adapter turns this into the request. */
export type RuntimeControlCommand =
  | { readonly action: 'model'; readonly model?: string; readonly effort?: string }
  | { readonly action: 'effort'; readonly effort: string }
  | { readonly action: 'fast'; readonly fast: boolean };

export interface RuntimeControlApi {
  /** The host sends this to the daemon it is bound to. The request id is fresh per click. */
  runtime(sessionId: string, command: RuntimeControlCommand, requestId: string): Promise<void>;
}

// Runtime control is owned by Runtimes; Ferrets keeps the ferret detail GET.
export const RUNTIME_SWITCH_ROUTE = 'POST /v1/ferrets/:id/runtime' as const;
export const FERRET_ROUTE = 'GET /v1/ferrets/:ferretId' as const;

/**
 * GAP(kernel): `PluginClient.call` carries no headers, so the per-click request id (the daemon's idempotency key
 * for this act) cannot ride along yet; the route refuses controls without that key until the client supports headers.
 */
export const runtimeControlApi = (client: RuntimesClient): RuntimeControlApi => ({
  runtime: async (sessionId, command) => {
    await client.call(RUNTIME_SWITCH_ROUTE, { params: { id: sessionId }, body: command });
  },
});

/**
 * The ferret as the pickers read it, projected from Ferrets' summary (`GET /v1/ferrets/:ferretId` serves
 * `FerretSummarySchema`: top-level `id`/`harness`/`model`, and `state` is one of four words). Today's whole session
 * document (`{ config, state }`) is not served by any 5.0 route.
 *
 * A field the summary does not carry (the model the pane OBSERVED, its prompt, the launch flags) is ABSENT, never
 * invented: the pickers already read each as "not known".
 */
const runtimeSessionViewOf = (summary: FerretSummary): RuntimeSessionView => ({
  config: {
    id: summary.id,
    harness: summary.harness,
    model: summary.model,
    launchReasoningEffort: summary.effort,
    launchFast: summary.fast,
  },
  state: stateOf(summary),
});

/** Ferrets' four states in the pickers' words: a live ferret is `running`, its turn decided by the daemon's turn watch. */
const stateOf = (summary: FerretSummary): RuntimeSessionView['state'] => {
  switch (summary.state) {
    case 'starting':
      return { status: 'starting' };
    case 'working':
      return { status: 'running', turnState: 'working' };
    case 'idle':
      return { status: 'running', turnState: 'your-turn' };
    case 'stopped':
      return { status: 'stopped' };
  }
};

/** What the daemon answered, read with the schema of the route that serves it (parse, don't validate). */
export const parseRuntimeSessionView = (value: unknown): RuntimeSessionView => {
  const parsed = FerretSummarySchema.safeParse(value);
  if (!parsed.success) throw new Error('the daemon answered with something the runtime picker cannot read as a ferret');
  return runtimeSessionViewOf(parsed.data);
};

export const readRuntimeSessionView = async (client: RuntimesClient, sessionId: string): Promise<RuntimeSessionView> =>
  parseRuntimeSessionView(await client.call(FERRET_ROUTE, { params: { ferretId: sessionId } }));
