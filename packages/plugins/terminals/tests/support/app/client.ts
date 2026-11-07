/**
 * A shell client with no daemon behind it: every call is recorded and answered from a script, and a socket is a
 * handle a test drives. A test can never reach a network or a live daemon through it.
 */

import { DaemonCallError, type SocketListeners, type TransportSocket } from '@ferretry/app';
import type { PluginClient } from '@ferretry/kernel/manifest';
import type { SocketPluginClient } from '../../../app/lib/web-terminals.ts';

export interface RecordedCall {
  readonly route: string;
  readonly init?: {
    readonly params?: Readonly<Record<string, string>>;
    readonly query?: Readonly<Record<string, string>>;
    readonly body?: unknown;
  };
}

type Init = NonNullable<RecordedCall['init']>;

/** Answers each call from `reply`; a reply that is an `Error` is thrown, as the shell throws a refusal. */
export function recordingClient(reply: (route: string, init: Init | undefined) => unknown) {
  const calls: RecordedCall[] = [];
  const client: PluginClient = {
    call: async <Answer>(route: string, init?: Init): Promise<Answer> => {
      calls.push(init === undefined ? { route } : { route, init });
      const answer = reply(route, init);
      if (answer instanceof Error) throw answer;
      return answer as Answer;
    },
    subscribe: () => () => undefined,
  };
  return { calls, client };
}

/** The same, answering from a list in turn (the last repeats). */
export function scriptedClient(...answers: readonly unknown[]) {
  let index = 0;
  return recordingClient(() => answers[Math.min(index++, answers.length - 1)]);
}

/** A refusal as the shell raises it. */
export const refusal = (status: number, message: string, code = `http_${status}`): DaemonCallError =>
  new DaemonCallError(status, code, message);

/** A client with one socket the test drives: what was opened, what was sent, and the daemon's side. */
export function socketClient() {
  const opened: { key: string; params: Readonly<Record<string, string>> }[] = [];
  const sent: (string | Uint8Array)[] = [];
  const closes: number[] = [];
  let listeners: SocketListeners | undefined;
  const client: SocketPluginClient = {
    call: async () => undefined as never,
    subscribe: () => () => undefined,
    socket: (key, params, given): TransportSocket => {
      opened.push({ key, params });
      listeners = given;
      return { send: frame => sent.push(frame), close: () => closes.push(1) };
    },
  };
  return {
    client,
    opened,
    sent,
    closes,
    /** The daemon's side of the open socket. */
    daemon: {
      frame: (frame: string | Uint8Array) => listeners?.onFrame(frame),
      close: (reason: string) => listeners?.onClose(reason),
    },
  };
}
