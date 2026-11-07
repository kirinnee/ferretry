/**
 * The pane in front of the reader, by its full `(daemonId, sessionId)` identity: what a quote goes to when its caller
 * names no pane. Copied from today's PWA (`pin-bridge.ts`).
 */

import { type QuoteScope, quoteScopeKey } from './quote-scope.ts';

let foreground: QuoteScope | null = null;

/** Declares the complete identity of the pane currently in front of the reader. */
export const setForegroundPinScope = (scope: QuoteScope | null): void => {
  if (foreground !== null && scope !== null && quoteScopeKey(foreground) === quoteScopeKey(scope)) return;
  foreground = scope;
};

/** Clears a departing pane only when it is still the foreground pane. */
export const clearForegroundPinScope = (scope: QuoteScope): void => {
  if (foreground !== null && quoteScopeKey(foreground) === quoteScopeKey(scope)) setForegroundPinScope(null);
};

export const getForegroundPinScope = (): QuoteScope | null => foreground;
