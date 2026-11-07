/**
 * WHICH FERRET A PIECE OF COMPOSER STATE BELONGS TO: the daemon and the ferret, and optionally the Agenda item whose
 * own draft slot it is (today's `daemon-scope.ts`, renamed to the words). Two paired daemons can hold ferrets with the
 * same id, so a draft, a quote target or a pinned pane is always named by both.
 */

/** A paired daemon's durable id, as the shell recorded it for the half's client. */
export type ComposerDaemonId = string;

export interface DaemonFerretScope {
  readonly daemonId: ComposerDaemonId;
  readonly ferretId: string;
  /**
   * The DRAFT SLOT inside the ferret: the agenda item whose own composer this is (an Inbox card). Absent is the
   * ferret's chat.
   */
  readonly item?: string;
}

const requireFerretId = (value: string): string => {
  if (value.trim() === '') throw new Error('ferretId must not be empty');
  return value;
};

/** Creates the required `(daemonId, ferretId)` identity; `item` names an Inbox card's own draft slot. */
export const daemonFerretScope = (
  daemon: { readonly daemonId: ComposerDaemonId },
  ferretId: string,
  item?: string,
): DaemonFerretScope => ({
  daemonId: daemon.daemonId,
  ferretId: requireFerretId(ferretId),
  ...(item === undefined ? {} : { item }),
});

/** A collision-safe key for persisted or in-memory ferret state; an item slot adds a third part. */
export const daemonFerretKey = (scope: DaemonFerretScope): string =>
  JSON.stringify(
    scope.item === undefined ? [scope.daemonId, scope.ferretId] : [scope.daemonId, scope.ferretId, scope.item],
  );

// ─── the pane in front of the reader (today's pin-bridge.ts) ──────────────────────────────────────────────────────

let foreground: DaemonFerretScope | null = null;

/**
 * Declares the complete identity of the pane currently in front of the reader. The ferret screen sets it (Ferrets'
 * pinned panes, Conversation's chat); a quote with no explicit scope goes there and nowhere else.
 */
export const setForegroundPinScope = (scope: DaemonFerretScope | null): void => {
  if (foreground !== null && scope !== null && daemonFerretKey(foreground) === daemonFerretKey(scope)) return;
  foreground = scope;
};

/** Clears a departing pane only when it is still the foreground pane. */
export const clearForegroundPinScope = (scope: DaemonFerretScope): void => {
  if (foreground !== null && daemonFerretKey(foreground) === daemonFerretKey(scope)) setForegroundPinScope(null);
};

export const getForegroundPinScope = (): DaemonFerretScope | null => foreground;
