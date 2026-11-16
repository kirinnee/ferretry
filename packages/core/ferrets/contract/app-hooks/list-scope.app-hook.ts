import { isRecord } from './shared/is-record.ts';

/**
 * `ferrets.list-scope`: which registered project a folder belongs to, and which folder the list is focused on. The
 * registry and the folder-mode machine are Projects' (the list cannot read either), so Projects PROVIDES it over its own
 * client on one daemon. Without a provider the list groups by the folder's base name and has no focus.
 */
export const FERRETS_LIST_SCOPE_HOOK = 'ferrets.list-scope' as const;

/** One group the list draws: the KEY is what a focus names (a normalised folder), the name is what a reader sees. */
export interface FerretListGroupKey {
  readonly key: string;
  readonly name: string;
}

/** What the list reads of the scope at one moment; a new object whenever the focus or the registry changed. */
export interface FerretListScopeSnapshot {
  /** The group key the list is focused on, or `null` for every folder. */
  readonly scope: string | null;
  /**
   * Whether the registry has answered. An unread registry covers no folder, so until it is known "no project covers
   * this focus" proves nothing: the list must not drop a focus (or rewrite the address) before then.
   */
  readonly known: boolean;
  /** The registered project a folder files under, or `null` when none covers it (the list groups by folder). */
  readonly groupOf: (folder: string) => FerretListGroupKey | null;
}

export interface FerretsListScope {
  readonly subscribe: (listener: () => void) => () => void;
  /** Keeps the registry read and the address followed until the returned release is called. */
  readonly watch: () => () => void;
  /** The same object until the focus or the registry changes. */
  readonly snapshot: () => FerretListScopeSnapshot;
  /** Focus one group (by its key). */
  readonly enter: (key: string) => void;
  /** Leave the focus. */
  readonly exit: () => void;
  /** The focused group names no folder this daemon knows: forget the focus and catch the address up. */
  readonly recover: () => void;
}

/** A provided value is read only when it has the shape: anything else is no provider. */
export const isFerretsListScope = (value: unknown): value is FerretsListScope =>
  isRecord(value) &&
  typeof value.subscribe === 'function' &&
  typeof value.watch === 'function' &&
  typeof value.snapshot === 'function' &&
  typeof value.enter === 'function' &&
  typeof value.exit === 'function' &&
  typeof value.recover === 'function';

export default { name: FERRETS_LIST_SCOPE_HOOK, narrow: isFerretsListScope } as const;
