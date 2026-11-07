/**
 * A plugin client a chat suite answers by hand: each route key maps to a handler that sees the call's init and
 * answers (or throws, as the daemon would refuse). An unanswered route throws, so a suite never passes on a read it
 * did not expect. Events and conditional reads are opt-in.
 */

import type { EventDef } from '@ferretry/kernel/contract';
import type { PluginClient } from '@ferretry/kernel/manifest';

export interface FakeCallInit {
  readonly params?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export type FakeRoute = (init: FakeCallInit) => unknown;

export interface FakeClient extends PluginClient {
  /** Every call made, in order: the route key and its init. */
  readonly calls: Array<{ readonly route: string; readonly init: FakeCallInit }>;
  /** Hands `payload` to every listener of `event`. */
  readonly emit: (event: string, payload: unknown) => void;
}

export const fakeClient = (
  routes: Readonly<Record<string, FakeRoute>>,
  conditional?: PluginClient['conditional'],
): FakeClient => {
  const calls: Array<{ readonly route: string; readonly init: FakeCallInit }> = [];
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const client: FakeClient = {
    calls,
    call: async <Answer = unknown>(route: string, init: FakeCallInit = {}): Promise<Answer> => {
      calls.push({ route, init });
      const handler = routes[route];
      if (handler === undefined) throw new Error(`unexpected call: ${route}`);
      return (await handler(init)) as Answer;
    },
    subscribe: <Name extends string, Payload>(event: EventDef<Name, Payload>, listener: (payload: Payload) => void) => {
      const set = listeners.get(event.name) ?? new Set();
      const wrapped = listener as (payload: unknown) => void;
      set.add(wrapped);
      listeners.set(event.name, set);
      return () => set.delete(wrapped);
    },
    emit: (event, payload) => {
      for (const listener of listeners.get(event) ?? []) listener(payload);
    },
    ...(conditional === undefined ? {} : { conditional }),
  };
  return client;
};
