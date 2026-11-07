/**
 * A shell client with no daemon behind it: every call is recorded and answered from a script, events are driven by the
 * test, and a socket is a handle a test drives. A test can never reach a network or a live daemon through it.
 */

import { DaemonCallError, type SocketListeners, type TransportSocket } from '@ferretry/app';
import type { EventDef } from '@ferretry/kernel/contract';
import type { PluginClient } from '@ferretry/kernel/manifest';
import type { BrowserDaemon } from '../../../app/lib/scope.ts';

export interface RecordedCall {
  readonly route: string;
  readonly init?: {
    readonly params?: Readonly<Record<string, string>>;
    readonly query?: Readonly<Record<string, string>>;
    readonly body?: unknown;
    readonly headers?: Readonly<Record<string, string>>;
  };
}

type Init = NonNullable<RecordedCall['init']>;

export interface Heard {
  /** Delivers an event to everyone listening for it. */
  readonly emit: <Payload>(event: EventDef<string, Payload>, payload: Payload) => void;
  readonly listening: () => number;
  /** Says whether the event feed is live, to everyone watching it. */
  readonly live: (live: boolean) => void;
}

/** Answers each call from `reply`; a reply that is an `Error` is thrown, as the shell throws a refusal. */
export function recordingClient(reply: (route: string, init: Init | undefined) => unknown | Promise<unknown>) {
  const calls: RecordedCall[] = [];
  const listeners = new Map<string, Set<(payload: never) => void>>();
  const liveListeners = new Set<(live: boolean) => void>();
  let feedLive = false;
  const client: PluginClient = {
    feed: {
      isLive: () => feedLive,
      subscribeLive: listener => {
        liveListeners.add(listener);
        return () => void liveListeners.delete(listener);
      },
    },
    call: async <Answer>(route: string, init?: Init): Promise<Answer> => {
      calls.push(init === undefined ? { route } : { route, init });
      const answer = await reply(route, init);
      if (answer instanceof Error) throw answer;
      return answer as Answer;
    },
    subscribe: (event, listener) => {
      const set = listeners.get(event.name) ?? new Set();
      listeners.set(event.name, set);
      set.add(listener as (payload: never) => void);
      return () => set.delete(listener as (payload: never) => void);
    },
  };
  const heard: Heard = {
    emit: (event, payload) => {
      for (const listener of [...(listeners.get(event.name) ?? [])]) (listener as (payload: unknown) => void)(payload);
    },
    listening: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
    live: live => {
      if (live === feedLive) return;
      feedLive = live;
      for (const listener of [...liveListeners]) listener(live);
    },
  };
  return { calls, client, heard };
}

/** The same, answering from a list in turn (the last repeats). */
export function scriptedClient(...answers: readonly unknown[]) {
  let index = 0;
  return recordingClient(() => answers[Math.min(index++, answers.length - 1)]);
}

/** A refusal as the shell raises it. */
export const refusal = (status: number, message: string, code = `http_${status}`): DaemonCallError =>
  new DaemonCallError(status, code, message);

/** A client with sockets the test drives: what was opened, what was sent, and the daemon's side. */
export function socketClient(reply: (route: string, init: Init | undefined) => unknown = () => undefined) {
  const base = recordingClient(reply);
  const opened: { key: string; params: Readonly<Record<string, string>> }[] = [];
  const sent: (string | Uint8Array)[] = [];
  const closes: { readonly code?: number; readonly reason?: string }[] = [];
  let listeners: SocketListeners | undefined;
  const client: PluginClient & {
    socket(key: string, params: Readonly<Record<string, string>>, given: SocketListeners): TransportSocket;
  } = {
    ...base.client,
    socket: (key, params, given): TransportSocket => {
      opened.push({ key, params });
      listeners = given;
      return { send: frame => sent.push(frame), close: (code, reason) => closes.push({ code, reason }) };
    },
  };
  return {
    ...base,
    client,
    opened,
    sent,
    closes,
    /** The daemon's side of the open socket. */
    daemon: {
      /** The daemon accepted the stream. */
      open: () => listeners?.onOpen?.(),
      frame: (frame: string | Uint8Array) => listeners?.onFrame(frame),
      close: (reason: string, code?: number) => listeners?.onClose(reason, code),
    },
  };
}

/** One daemon as a surface sees it: its id and the client the shell gave the half. */
export const browserDaemon = (client: PluginClient, daemonId = 'daemon-a'): BrowserDaemon => ({ daemonId, client });

let pairings = 0;
const grants = new WeakMap<object, string>();
/** The label a test gave a pairing's grant (never a real credential), read back where the grant must be told apart. */
export const grantOf = (daemon: BrowserDaemon): string => grants.get(daemon.client) ?? '';
/**
 * A daemon with a client of its own, unscripted. Two calls make two pairings of the same daemon id: a re-pair is a new
 * client, and nothing that held the old one may report into the new one.
 */
export const daemonConnection = (
  options: { readonly daemonId?: string; readonly client?: PluginClient; readonly grant?: string } = {},
): BrowserDaemon => {
  pairings += 1;
  const client = options.client ?? recordingClient(() => undefined).client;
  if (options.grant !== undefined) grants.set(client, options.grant);
  return { daemonId: options.daemonId ?? `daemon-${pairings}`, client };
};
