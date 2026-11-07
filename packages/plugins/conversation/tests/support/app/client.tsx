/**
 * A fake of the half's client for the app tests: every `call` is recorded, and answered by the handler a suite gives
 * for its route key. A handler that throws a `DaemonCallError` is the daemon's refusal; a route with no handler is a
 * test failure that names it. `withClient` wraps a view in the client context the half's surfaces give it.
 */

import { DaemonCallError, ScreenHrefProvider } from '@ferretry/app';
import { noteClientDaemon } from '@ferretry/app/testing';
import type { PluginClient } from '@ferretry/kernel/manifest';
import type { ReactElement, ReactNode } from 'react';
import { ConversationClientProvider } from '../../../app/client.ts';

export interface RecordedCall {
  readonly route: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string>>;
}

export type CallHandler = (call: RecordedCall) => unknown;

export interface FakeClient extends PluginClient {
  readonly calls: RecordedCall[];
  /** Calls made to one route key. */
  readonly callsTo: (route: string) => readonly RecordedCall[];
  /** Replaces or adds a route's handler. */
  readonly on: (route: string, handler: CallHandler) => void;
}

/** A client answering `routes`; `daemon` is recorded as the daemon it reaches, as the shell does. */
export const fakeClient = (routes: Readonly<Record<string, CallHandler>> = {}, daemon = 'd1'): FakeClient => {
  const handlers = new Map(Object.entries(routes));
  const calls: RecordedCall[] = [];
  const client: FakeClient = {
    calls,
    callsTo: route => calls.filter(call => call.route === route),
    on: (route, handler) => {
      handlers.set(route, handler);
    },
    call: async <Answer,>(route: string, init: Parameters<PluginClient['call']>[1] = {}): Promise<Answer> => {
      const call: RecordedCall = {
        route,
        params: init.params ?? {},
        query: init.query ?? {},
        body: init.body,
        headers: { ...(init.headers ?? {}) },
      };
      calls.push(call);
      const handler = handlers.get(route);
      if (handler === undefined) throw new Error(`the fake client has no handler for ${route}`);
      return (await handler(call)) as Answer;
    },
    subscribe: () => () => undefined,
  };
  noteClientDaemon(client, daemon);
  return client;
};

/** The daemon's refusal, as the shell's client throws it. */
export const refusal = (status: number, code: string, message: string): DaemonCallError =>
  new DaemonCallError(status, code, message);

/** Every screen address a suite's views ask for, spelled `/<daemon>/<plugin>/<screen>?<params>`. */
export const testHref = (
  daemon: string,
  plugin: string,
  screen: string,
  params: Readonly<Record<string, string>> = {},
) =>
  `/${daemon}/${plugin}/${screen}${Object.keys(params).length === 0 ? '' : `?${new URLSearchParams(params).toString()}`}`;

/** A view inside the client context (and a screen-address table), as a surface draws it. */
export const withClient = (client: PluginClient, view: ReactNode): ReactElement => (
  <ScreenHrefProvider href={testHref}>
    <ConversationClientProvider client={client}>{view}</ConversationClientProvider>
  </ScreenHrefProvider>
);
