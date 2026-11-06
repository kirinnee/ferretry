import { type DaemonSessionScope, daemonSessionKey } from './daemon-scope.ts';

let foreground: DaemonSessionScope | null = null;

/** Declares the complete identity of the pane currently in front of the reader. */
export const setForegroundPinScope = (scope: DaemonSessionScope | null): void => {
  if (foreground !== null && scope !== null && daemonSessionKey(foreground) === daemonSessionKey(scope)) return;
  foreground = scope;
};

/** Clears a departing pane only when it is still the foreground pane. */
export const clearForegroundPinScope = (scope: DaemonSessionScope): void => {
  if (foreground !== null && daemonSessionKey(foreground) === daemonSessionKey(scope)) setForegroundPinScope(null);
};

export const getForegroundPinScope = (): DaemonSessionScope | null => foreground;
