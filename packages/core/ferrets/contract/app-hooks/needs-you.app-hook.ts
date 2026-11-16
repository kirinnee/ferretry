import { isRecord } from './shared/is-record.ts';

/** Which of this daemon's ferrets have open items waiting on the owner. */
export const FERRETS_NEEDS_YOU_HOOK = 'ferrets.needs-you' as const;

/** One ferret that waits on the owner. */
export interface FerretNeedsYou {
  /** How many open items wait on the owner: the count badge. Always 1 or more. */
  readonly count: number;
  /** When the newest of them began waiting, as an instant: the group lists the newest first. */
  readonly latestAt: string;
  /** The first open item's ask, in the owner's words: the row's one-line preview. May be empty. */
  readonly ask: string;
}

/** `ferrets.needs-you`: the ferrets of the daemon the provider was built for that wait on the owner, by ferret id. */
export interface FerretsNeedsYou {
  readonly subscribe: (listener: () => void) => () => void;
  /** Keeps the answer read and live until the returned release is called. */
  readonly watch: () => () => void;
  /** The same map until the answer changes. A ferret with nothing open is absent. */
  readonly needing: () => ReadonlyMap<string, FerretNeedsYou>;
}

/** A provided value is read only when it has the shape: anything else is no provider. */
export const isFerretsNeedsYou = (value: unknown): value is FerretsNeedsYou =>
  isRecord(value) &&
  typeof value.subscribe === 'function' &&
  typeof value.watch === 'function' &&
  typeof value.needing === 'function';

export default { name: FERRETS_NEEDS_YOU_HOOK, narrow: isFerretsNeedsYou } as const;
