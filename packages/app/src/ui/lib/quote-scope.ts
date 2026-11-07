/**
 * Which composer a quote is for: the daemon and the conversation, and — for an ask's own composer — the ask. A plugin's
 * own scope type (an Agenda `DaemonSessionScope`, a Conversation pane) is structurally one of these.
 */

export interface QuoteScope {
  readonly daemonId: string;
  readonly sessionId: string;
  readonly item?: string | undefined;
}

/** A collision-safe key for one scope. */
export const quoteScopeKey = (scope: QuoteScope): string =>
  JSON.stringify(
    scope.item === undefined ? [scope.daemonId, scope.sessionId] : [scope.daemonId, scope.sessionId, scope.item],
  );
