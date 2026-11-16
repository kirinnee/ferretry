/**
 * THE ONE FAKE OF THE HALF'S CLIENT for every app suite: each `call` is recorded and answered by the handler a suite
 * gives for its route key (or by one function for every route). A handler that throws a `DaemonCallError` is the
 * daemon's refusal; a route with no handler is a test failure that names it, so a suite never passes on a read it did
 * not expect. Events (`emit`), conditional reads and a draft socket are opt-in, through `options.more`.
 */

import { DaemonCallError } from '@ferretry/app';
import { noteClientDaemon } from '@ferretry/app/testing';
import type { EventDef } from '@ferretry/kernel/contract';
import type { PluginClient } from '@ferretry/kernel/manifest';

export interface RecordedCall {
  readonly route: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string>>;
}

export type CallHandler = (call: RecordedCall) => unknown;

export interface FakeClient extends PluginClient {
  /** Every call made, in order. */
  readonly calls: RecordedCall[];
  /** Calls made to one route key. */
  readonly callsTo: (route: string) => readonly RecordedCall[];
  /** Replaces or adds a route's handler. */
  readonly on: (route: string, handler: CallHandler) => void;
  /** Hands `payload` to every listener of `event`. */
  readonly emit: (event: string, payload: unknown) => void;
}

export interface FakeClientOptions {
  /** The daemon the client is recorded as reaching, as the shell records the real ones; unnamed, the client names no daemon and is trusted with its scope. */
  readonly daemon?: string;
  /** What the client has beside `call`: a `socket`, a `conditional` read. */
  readonly more?: Partial<PluginClient>;
}

/** A client answering `answers`: one handler per route key, or one function for every route. */
export const fakeClient = (
  answers: Readonly<Record<string, CallHandler>> | CallHandler = {},
  options: FakeClientOptions | string = {},
): FakeClient => {
  const { daemon, more = {} }: FakeClientOptions = typeof options === 'string' ? { daemon: options } : options;
  const handlers = new Map(typeof answers === 'function' ? [] : Object.entries(answers));
  const calls: RecordedCall[] = [];
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const client: FakeClient = {
    calls,
    callsTo: route => calls.filter(call => call.route === route),
    on: (route, handler) => {
      handlers.set(route, handler);
    },
    call: async <Answer>(route: string, init: Parameters<PluginClient['call']>[1] = {}): Promise<Answer> => {
      const call: RecordedCall = {
        route,
        params: init.params ?? {},
        query: init.query ?? {},
        body: init.body,
        headers: { ...(init.headers ?? {}) },
      };
      calls.push(call);
      const handler = handlers.get(route) ?? (typeof answers === 'function' ? answers : undefined);
      if (handler === undefined) throw new Error(`the fake client has no handler for ${route}`);
      return (await handler(call)) as Answer;
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
    ...more,
  };
  if (daemon !== undefined) noteClientDaemon(client, daemon);
  return client;
};

/** The daemon's refusal, as the shell's client throws it. */
export const refusal = (status: number, code: string, message: string): DaemonCallError =>
  new DaemonCallError(status, code, message);
