/**
 * A scripted daemon for the list suites: the ferrets it holds, the events it can announce, the reads it was asked for,
 * and a way to make the next read fail or wait.
 */
import type { LiveFerretsClient } from '../../../../app/lib/client.ts';
import { FerretsChanged, type FerretSummary } from '../../../../contract/index.ts';
import { ferretSummary } from '../header/support.ts';

/** A ferret as the list reads it, with any field a test names changed (instants and ids as the plain text a daemon sends). */
export const summary = (id: string, over: Readonly<Record<string, unknown>> = {}): FerretSummary =>
  ferretSummary(id, over as Partial<FerretSummary>);

type Listener = (payload: { ferret: string; generation: number; state?: string; gone?: true }) => void;

export interface ListDaemon {
  readonly client: LiveFerretsClient;
  ferrets: readonly FerretSummary[];
  reads: number;
  /** A refusal for the next reads, or `undefined` for none. */
  failWith: Error | undefined;
  /** When set, each read waits for this promise before answering. */
  hold: Promise<void> | undefined;
  readonly announce: (ferret: string, gone?: true) => void;
  readonly listeners: Set<Listener>;
}

export const listDaemon = (ferrets: readonly FerretSummary[], options: { conditional?: boolean } = {}): ListDaemon => {
  const listeners = new Set<Listener>();
  const daemon: ListDaemon = {
    ferrets,
    reads: 0,
    failWith: undefined,
    hold: undefined,
    listeners,
    announce: (ferret, gone) => {
      for (const listener of listeners) listener({ ferret, generation: 1, ...(gone === true ? { gone } : {}) });
    },
    client: {
      call: (async (route: string) => {
        if (route !== 'GET /v1/ferrets') throw new Error(`no route ${route}`);
        daemon.reads += 1;
        await daemon.hold;
        if (daemon.failWith !== undefined) throw daemon.failWith;
        return daemon.ferrets;
      }) as LiveFerretsClient['call'],
      subscribe: ((event: { name: string }, listener: Listener) => {
        if (event.name !== FerretsChanged.name) throw new Error(`unexpected event ${event.name}`);
        listeners.add(listener);
        return () => listeners.delete(listener);
      }) as never,
    },
  };
  if (options.conditional === true)
    (daemon.client as { conditional?: LiveFerretsClient['conditional'] }).conditional = async () => {
      daemon.reads += 1;
      await daemon.hold;
      if (daemon.failWith !== undefined) throw daemon.failWith;
      return { status: 200, etag: `"e${daemon.reads}"`, body: daemon.ferrets };
    };
  return daemon;
};
