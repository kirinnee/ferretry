/** A ferret row in the list: plugins draw a small mark on it (Usage: the account's quota). */
export const FERRET_LIST_ROW_MARK_SLOT = 'ferrets.list-row-mark' as const;

/** What a list row hands a mark panel: the ferret, the runtime it runs on and the login that runtime signs in with. */
export interface FerretListRowMarkSlotProps {
  readonly ferret: string;
  /** The runtime's name on this daemon. It is NOT an account id: a feed never names its rows by it. */
  readonly runtime: string;
  /**
   * The login (the account) the ferret launched on, on this daemon: what an account feed names its rows by. Absent for
   * a ferret whose record names none, and then a mark that needs an account draws nothing. Additive and optional.
   */
  readonly login?: string;
}

export function isFerretListRowMarkSlotProps(props: unknown): props is FerretListRowMarkSlotProps {
  if (typeof props !== 'object' || props === null) return false;
  const candidate = props as Record<string, unknown>;
  return typeof candidate.ferret === 'string' && typeof candidate.runtime === 'string';
}

export default { slot: FERRET_LIST_ROW_MARK_SLOT } as const;
