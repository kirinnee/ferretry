import { useMemo, useSyncExternalStore } from 'react';
import { useOptionalDevice } from './device-context.tsx';

/**
 * THE INSTALL PROMPT, CAPTURED AT BOOT (shell contract S13). Chromium decides on its own when the app is installable
 * and fires `beforeinstallprompt` ONCE; keeping that event is the only way a page can later open the browser's install
 * dialog. A lazily loaded half would never be mounted in time to hear it, so `main.tsx` listens before anything renders
 * and holds the event here, in the device context (S9). iOS has no event and no API: a person adds the app from the Share
 * sheet, and `platform: 'ios'` is how a view knows to say where.
 *
 * Nothing here decides whether to OFFER the install (a dismissal, a banner): that is the plugin's — Updates draws the
 * offer as a `device.settings` panel and a `background` toast over `useInstallPrompt`. This holds the browser's fact.
 * The held event is single-use by the browser's rule, so whatever the person answers, it is released. The event is the
 * browser's own dialog: nothing in it is a credential and nothing here leaves the page.
 */

/** The browser's deferred install prompt — the slice of `BeforeInstallPromptEvent` this uses. */
export interface DeferredInstallPrompt {
  prompt(): Promise<unknown>;
  readonly userChoice: Promise<{ readonly outcome: 'accepted' | 'dismissed' }>;
}

/** What a device reports about itself — read once at start. */
export interface InstallEnvironment {
  readonly userAgent: string;
  readonly maxTouchPoints: number;
  /** `matchMedia('(display-mode: standalone)')` — true inside an installed app. */
  readonly standaloneDisplay: boolean;
  /** iOS Safari's own flag for a home-screen app; `undefined` everywhere else. */
  readonly navigatorStandalone?: boolean | undefined;
}

/** `installed` — already running as the app; `ios` — the Share sheet is the only way in; `browser` — anything else. */
export type InstallPlatform = 'installed' | 'ios' | 'browser';

export type InstallOutcome = 'accepted' | 'dismissed' | 'unavailable';

/** What a view reads of the install prompt. */
export interface InstallPromptState {
  readonly platform: InstallPlatform;
  /** Chromium offered installation and the event is still held. */
  readonly canPrompt: boolean;
}

/** The held prompt, as the device context carries it: readable, observable, and spendable once. */
export interface InstallPromptHolder {
  readonly subscribe: (listener: () => void) => () => void;
  readonly snapshot: () => InstallPromptState;
  /** Opens the browser's own dialog, once; `unavailable` when none is held. */
  readonly prompt: () => Promise<InstallOutcome>;
}

const IOS_DEVICE = /\b(iPhone|iPad|iPod)\b/u;

export const installPlatform = (environment: InstallEnvironment): InstallPlatform => {
  if (environment.standaloneDisplay || environment.navigatorStandalone === true) return 'installed';
  // iPadOS 13+ announces itself as a Mac; only its touch screen gives it away.
  const iPadAsMac = /\bMacintosh\b/u.test(environment.userAgent) && environment.maxTouchPoints > 1;
  return IOS_DEVICE.test(environment.userAgent) || iPadAsMac ? 'ios' : 'browser';
};

/** The one place the held event lives. */
export class InstallPromptCapture implements InstallPromptHolder {
  readonly #listeners = new Set<() => void>();
  #held: DeferredInstallPrompt | null = null;
  #state: InstallPromptState;

  constructor(platform: InstallPlatform) {
    this.#state = { platform, canPrompt: false };
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly snapshot = (): InstallPromptState => this.#state;

  /** The browser offered installation; keep the event for when the person asks. */
  capture(event: DeferredInstallPrompt): void {
    this.#held = event;
    this.#set({ canPrompt: true });
  }

  /** The app is installed (the browser said so, or an accepted prompt): nothing more to offer this visit. */
  markInstalled(): void {
    this.#held = null;
    this.#set({ platform: 'installed', canPrompt: false });
  }

  readonly prompt = async (): Promise<InstallOutcome> => {
    const held = this.#held;
    if (held === null) return 'unavailable';
    // Single-use by the browser's rule: released whatever the person answers.
    this.#held = null;
    this.#set({ canPrompt: false });
    try {
      await held.prompt();
      const { outcome } = await held.userChoice;
      if (outcome === 'accepted') this.markInstalled();
      return outcome;
    } catch {
      return 'unavailable';
    }
  };

  #set(patch: Partial<InstallPromptState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }
}

/** The holder a harness or a build without a browser uses: this is a browser tab that was never offered an install. */
export const NO_INSTALL_PROMPT: InstallPromptHolder = Object.freeze({
  subscribe: () => () => {},
  snapshot: Object.freeze((): InstallPromptState => NOT_OFFERED),
  prompt: async (): Promise<InstallOutcome> => 'unavailable',
});
const NOT_OFFERED: InstallPromptState = Object.freeze({ platform: 'browser', canPrompt: false });

/** The slice of `window` the install wiring listens on. */
export interface InstallEventTarget {
  addEventListener(type: 'beforeinstallprompt' | 'appinstalled', listener: (event: Event) => void): void;
}

/**
 * Listens for the browser's offer and for a finished install. `preventDefault` stops Chromium's own mini-infobar, so the
 * only offer the person sees is the app's own.
 */
export const attachInstallPrompt = (capture: InstallPromptCapture, target: InstallEventTarget): void => {
  target.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    capture.capture(event as unknown as DeferredInstallPrompt);
  });
  target.addEventListener('appinstalled', () => capture.markInstalled());
};

/** The slice of `window` read once at start. */
export interface InstallWindow {
  readonly navigator: { readonly userAgent: string; readonly maxTouchPoints: number; readonly standalone?: boolean };
  matchMedia(query: string): { readonly matches: boolean };
}

export const browserInstallEnvironment = (win: InstallWindow): InstallEnvironment => ({
  userAgent: win.navigator.userAgent,
  maxTouchPoints: win.navigator.maxTouchPoints,
  standaloneDisplay: win.matchMedia('(display-mode: standalone)').matches,
  navigatorStandalone: win.navigator.standalone,
});

/** The production holder: this device's platform and the browser's events, listened to from the moment this runs. */
export const createBrowserInstallPrompt = (win: InstallWindow & InstallEventTarget): InstallPromptCapture => {
  const capture = new InstallPromptCapture(installPlatform(browserInstallEnvironment(win)));
  attachInstallPrompt(capture, win);
  return capture;
};

export interface InstallPrompt extends InstallPromptState {
  /** Opens the browser's install dialog, once. */
  readonly prompt: () => Promise<InstallOutcome>;
}

const NOT_AVAILABLE: InstallPrompt = Object.freeze({
  platform: 'browser',
  canPrompt: false,
  prompt: async (): Promise<InstallOutcome> => 'unavailable',
});

/**
 * THE INSTALL PROMPT (S13), daemon-less safe: served from the device context, so it answers on a daemon-less screen, in a
 * device panel and in a per-daemon view alike. Outside an app shell (a harness or suite) it is never offered.
 */
export function useInstallPrompt(): InstallPrompt {
  const device = useOptionalDevice();
  const holder = device?.install ?? NO_INSTALL_PROMPT;
  const state = useSyncExternalStore(holder.subscribe, holder.snapshot, holder.snapshot);
  const prompt = holder.prompt;
  const offer = useMemo<InstallPrompt>(
    () => ({ platform: state.platform, canPrompt: state.canPrompt, prompt }),
    [state.platform, state.canPrompt, prompt],
  );
  return device === null ? NOT_AVAILABLE : offer;
}
