/**
 * Helpers for the Runtimes tab, machine-data and default-runtime suites: a daemon refusal as the shell's client
 * throws it, a client that holds every call until released, and a client that hears events the way the shell's does.
 */

import type { LiveRuntimesClient, RuntimesClient } from '../../../../../../app/lib/client.ts';
import { scripted } from '../account-support.ts';

/** A refusal the daemon answered, with the structural fields (`status`, `code`, `message`) the shell's client puts on it. */
export class DaemonCallError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code = 'refused') {
    super(message);
    this.name = 'DaemonCallError';
    this.status = status;
    this.code = code;
  }
}

/** A client that holds every request until released, then answers from `routes`. */
export const gated = (routes: Record<string, unknown>) => {
  let release: () => void = () => undefined;
  const open = new Promise<void>(resolve => {
    release = resolve;
  });
  const inner = scripted(routes);
  const client: RuntimesClient = {
    call: async (route, init) => {
      await open;
      return await inner.call(route, init);
    },
  };
  return { client, release };
};

/** A client that answers nothing: every call fails the way an unreachable daemon does. */
export const offline = (message = 'offline'): RuntimesClient => ({
  call: async () => {
    throw new Error(message);
  },
});

type Listener = (payload: unknown) => void;

/** A scripted client that also hears events: `emit` delivers a payload to everything subscribed to that event name. */
export const live = (client: RuntimesClient) => {
  const named = new Map<string, Set<Listener>>();
  const subscribed: LiveRuntimesClient = {
    call: client.call,
    subscribe: ((event: { name: string }, listener: Listener) => {
      const set = named.get(event.name) ?? new Set<Listener>();
      set.add(listener);
      named.set(event.name, set);
      return () => {
        set.delete(listener);
      };
    }) as unknown as NonNullable<LiveRuntimesClient['subscribe']>,
  };
  return {
    client: subscribed,
    emit: (name: string, payload: unknown): void => {
      for (const listener of [...(named.get(name) ?? [])]) listener(payload);
    },
    listening: (name: string): number => named.get(name)?.size ?? 0,
  };
};
