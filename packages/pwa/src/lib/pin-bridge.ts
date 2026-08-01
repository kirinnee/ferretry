import { type DaemonSessionScope, daemonSessionKey } from './daemon-scope.ts';

/** The honest result of asking the currently visible transcript to locate a pin. */
export type PinJumpOutcome = 'jumped' | 'not-found' | 'no-transcript';

export interface PinJumpController {
  /** A retained background pane must never receive a jump request. */
  isForeground(): boolean;
  jumpTo(blockId: string, onProgress?: (olderPagesLoaded: number) => void): Promise<PinJumpOutcome>;
}

type Listener = () => void;

const controllers = new Set<PinJumpController>();
const listeners = new Set<Listener>();
let foreground: DaemonSessionScope | null = null;

/** Declares the complete identity of the pane currently in front of the reader. */
export const setForegroundPinScope = (scope: DaemonSessionScope | null): void => {
  if (foreground !== null && scope !== null && daemonSessionKey(foreground) === daemonSessionKey(scope)) return;
  if (foreground === scope) return;
  foreground = scope;
  for (const listener of listeners) listener();
};

/** Clears a departing pane only when it is still the foreground pane. */
export const clearForegroundPinScope = (scope: DaemonSessionScope): void => {
  if (foreground !== null && daemonSessionKey(foreground) === daemonSessionKey(scope)) setForegroundPinScope(null);
};

export const getForegroundPinScope = (): DaemonSessionScope | null => foreground;

export const subscribeForegroundPinScope = (listener: Listener): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The visible transcript owns scrolling; this registry never writes scroll position. */
export const registerPinJumpController = (controller: PinJumpController): (() => void) => {
  controllers.add(controller);
  return () => controllers.delete(controller);
};

export const foregroundPinJumpController = (): PinJumpController | null => {
  for (const controller of controllers) {
    try {
      if (controller.isForeground()) return controller;
    } catch {
      // A controller in teardown is no longer a candidate.
    }
  }
  return null;
};

/** Requests an exact-id jump, with an explicit outcome when no transcript is mounted. */
export const requestPinJump = async (
  blockId: string,
  onProgress?: (olderPagesLoaded: number) => void,
): Promise<PinJumpOutcome> => {
  const controller = foregroundPinJumpController();
  return controller === null ? 'no-transcript' : controller.jumpTo(blockId, onProgress);
};
