/**
 * The in-place switch of a running ferret's model, reasoning level or fast mode, and the read of its session
 * document, over the daemon's client. Pure over an injected client; the pickers in `components/runtime-controls.tsx`
 * only see `RuntimeControlApi`.
 */

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

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** The session document, trusted for nothing but the fields the runtime pickers read. */
export const parseRuntimeSessionView = (value: unknown): RuntimeSessionView => {
  const root = asObject(value);
  const config = asObject(root?.config);
  const state = asObject(root?.state);
  const harness = config?.harness;
  if (
    typeof config?.id !== 'string' ||
    (harness !== 'claude-code' && harness !== 'codex') ||
    typeof state?.status !== 'string'
  )
    throw new Error('daemon returned an invalid ferret');
  const text = (field: unknown): string | undefined => (typeof field === 'string' ? field : undefined);
  const flag = (field: unknown): boolean | undefined => (typeof field === 'boolean' ? field : undefined);
  return {
    config: {
      id: config.id,
      harness,
      model: text(config.model),
      modelHint: text(config.modelHint),
      harnessFlags: Array.isArray(config.harnessFlags)
        ? config.harnessFlags.filter((entry): entry is string => typeof entry === 'string')
        : undefined,
      launchReasoningEffort: text(config.launchReasoningEffort),
      launchFast: flag(config.launchFast),
    },
    state: {
      status: state.status,
      turnState: text(state.turnState),
      promptReady: flag(state.promptReady),
      observedModel: text(state.observedModel),
      observedReasoningEffort: text(state.observedReasoningEffort),
      observedFast: flag(state.observedFast),
    },
  };
};

export const readRuntimeSessionView = async (client: RuntimesClient, sessionId: string): Promise<RuntimeSessionView> =>
  parseRuntimeSessionView(await client.call(FERRET_ROUTE, { params: { ferretId: sessionId } }));
