/**
 * IS A PERSON AT THIS DEVICE RIGHT NOW?
 *
 * The daemon expires a device nobody has used for 30 days, and only a request marked `presence`
 * counts as use. Without the mark, an open tab that renews its session by itself — a forgotten laptop,
 * a phone left on a table with the app open — would keep a device paired forever, and the idle expiry
 * would be a control that never fires (`docs/design/zero-trust.md` A6).
 *
 * A PERSON is: the page is visible, and somebody touched, clicked or typed in it in the last five
 * minutes — a TRUSTED event, one the browser raised for real input, never one a script dispatched. A
 * page that merely loaded is not a person: a browser restoring its tabs at login, an installed app
 * launched at login and an automatic reload all load the page with nobody there. A background tab
 * polling for events is none of those either.
 *
 * It is a SIGNAL FROM THE DEVICE ITSELF, and that is enough: the threat it answers is a forgotten
 * device, not a hostile one. Somebody actively using a stolen phone IS present; revocation is the
 * control for that.
 */

/** How long one interaction keeps the page counted as attended. */
export const PRESENCE_WINDOW_MS = 5 * 60_000;

/** What the tracker reads from the page, injected so a suite needs no browser. */
export interface PresenceEnvironment {
  readonly now: () => number;
  readonly visible: () => boolean;
  /** Registers the listener for a person's real input; returns how to remove it. */
  readonly onInteraction: (listener: () => void) => () => void;
}

export class PresenceTracker {
  #lastInteractionMs: number | undefined;
  readonly #stop: () => void;

  constructor(private readonly environment: PresenceEnvironment) {
    this.#stop = environment.onInteraction(() => {
      this.#lastInteractionMs = environment.now();
    });
  }

  present(): boolean {
    if (!this.environment.visible()) return false;
    return (
      this.#lastInteractionMs !== undefined && this.environment.now() - this.#lastInteractionMs < PRESENCE_WINDOW_MS
    );
  }

  stop(): void {
    this.#stop();
  }
}

const INTERACTIONS = ['pointerdown', 'keydown', 'touchstart'] as const;

/** The page's own signals: visibility, and a person's input anywhere in it. */
export const browserPresenceEnvironment = (): PresenceEnvironment => ({
  now: () => Date.now(),
  visible: () => globalThis.document?.visibilityState !== 'hidden',
  onInteraction: listener => {
    const target = globalThis.window;
    if (target === undefined) return () => undefined;
    // Only input the browser itself raised: a script in the page can dispatch a keydown, and a person
    // is exactly what such a script is not.
    const trusted = (event: Event): void => {
      if (event.isTrusted) listener();
    };
    for (const type of INTERACTIONS) target.addEventListener(type, trusted, { capture: true, passive: true });
    return () => {
      for (const type of INTERACTIONS) target.removeEventListener(type, trusted, { capture: true });
    };
  },
});
