/**
 * A shell client with no daemon behind it: every call is recorded and answered from a script, events are driven by the
 * test. A test can never reach a network or a live daemon through it.
 */
import type { EventDef } from '../../contract/index.ts';
import type { PluginClient } from '../../manifest/index.ts';

interface RecordedCall {
  readonly route: string;
  readonly init?: { readonly query?: Readonly<Record<string, string>>; readonly body?: unknown };
}

type Init = NonNullable<RecordedCall['init']>;

/** A refusal as the shell raises it: an error carrying the daemon's status, code and body. */
export class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

/** Answers each call from `reply`; a reply that is an `Error` is thrown, as the shell throws a refusal. */
export function recordingClient(reply: (route: string, init: Init | undefined) => unknown | Promise<unknown>) {
  const calls: RecordedCall[] = [];
  const listeners = new Map<string, Set<(payload: never) => void>>();
  const client: PluginClient = {
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
  return {
    calls,
    client,
    emit: <Payload>(event: EventDef<string, Payload>, payload: Payload): void => {
      for (const listener of [...(listeners.get(event.name) ?? [])]) (listener as (payload: unknown) => void)(payload);
    },
  };
}
