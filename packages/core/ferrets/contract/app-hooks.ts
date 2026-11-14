/**
 * THE APP HOOKS FERRETS OFFERS (§5.2; `@ferretry/app`'s `useAppHook`, a provider's `shell.hooks`).
 *
 * Which ferrets have something waiting on the owner is the Agenda's fact (its open items), and the list that gathers
 * them into "Needs you" at the top is Ferrets'. Neither half imports the other: Ferrets OFFERS the hook below and the
 * plugin that holds the items PROVIDES it, over its own client on one daemon. The name and the shape are the whole
 * agreement; Ferrets narrows what it is given before it reads it.
 *
 * FAIL CLOSED. With no provider (Agenda not installed, not allowed on that daemon, or two plugins providing the name),
 * the list draws as it does without one: every ferret in its folder, nothing gathered.
 *
 * The value is plain data and functions (no framework type: this is a contract).
 */

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

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** A provided value is read only when it has the shape: anything else is no provider. */
export const isFerretsNeedsYou = (value: unknown): value is FerretsNeedsYou =>
  isRecord(value) &&
  typeof value.subscribe === 'function' &&
  typeof value.watch === 'function' &&
  typeof value.needing === 'function';

/**
 * THE DECLARATION: every app hook Ferrets offers, with the narrowing that says a provided value has its shape. The
 * `app-hooks` check (`scripts/validate/app-hooks.ts`) pairs it with what the compiled-in halves provide and fails the
 * build when the hook has no provider, has two, or is built into a value that does not pass.
 */
export const FERRETS_APP_HOOKS = {
  [FERRETS_NEEDS_YOU_HOOK]: isFerretsNeedsYou,
} as const;
