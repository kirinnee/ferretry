/**
 * A shell client with no daemon behind it: every call is recorded and answered from a script, and a socket is a
 * handle a test drives. A test can never reach a network or a live daemon through it.
 */

import { DaemonCallError, type SocketCloseDetail, type SocketListeners, type TransportSocket } from '@ferretry/app';
import type { SocketPluginClient } from '../../../app/lib/web-terminals.ts';
import type { TextPluginClient } from '../../../app/components/terminal-snapshot-model.ts';

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
  const answer = (route: string, init: Init | undefined): unknown => {
    calls.push(init === undefined ? { route } : { route, init });
    const given = reply(route, init);
    if (given instanceof Error) throw given;
    return given;
  };
  const client: TextPluginClient = {
    call: async <Answer>(route: string, init?: Init): Promise<Answer> => answer(route, init) as Answer,
    /** A text read answers with exactly the string scripted — the shell hands it over undecoded. */
    callText: async (route: string, init?: Init): Promise<string> => String(answer(route, init) ?? ''),
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
  const opened: { key: string; params: Readonly<Record<string, string>>; query?: Readonly<Record<string, string>> }[] =
    [];
  const sent: (string | Uint8Array)[] = [];
  const closes: number[] = [];
  let listeners: SocketListeners | undefined;
  const client: SocketPluginClient = {
    call: async () => undefined as never,
    subscribe: () => () => undefined,
    socket: (key, params, given, query): TransportSocket => {
      opened.push(query === undefined ? { key, params } : { key, params, query });
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
      /** The daemon accepted the stream (the shell's `onOpen`). */
      open: () => listeners?.onOpen?.(),
      close: (reason: string, detail?: SocketCloseDetail) => listeners?.onClose(reason, detail),
    },
  };
}
