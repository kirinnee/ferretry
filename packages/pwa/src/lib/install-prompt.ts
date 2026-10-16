/**
 * INSTALLING FERRETRY AS AN APP — what this device can do, and whether to offer it.
 *
 * The owner asked for the PWA to "prompt the user to install as an app". Browsers differ in exactly
 * one way that matters here:
 *
 *   * CHROMIUM (Android, desktop) decides on its own when the app is installable and then fires
 *     `beforeinstallprompt`. Keeping that event is the ONLY way a page can later open the browser's
 *     install dialog, so it is captured as early as the app starts (`main.tsx`) and held here.
 *   * iOS has no event and no API at all: a person adds the app from the Share sheet. The most a page
 *     can do is say where — "Tap Share › Add to Home Screen".
 *
 * Nothing is offered to an app that is ALREADY running installed (`display-mode: standalone`, or
 * iOS's own `navigator.standalone`), and a dismissal is remembered on this device, so the offer is
 * made once and never nags. Settings › This device › Install app stays available either way.
 */

/** The browser's deferred install prompt — the slice of `BeforeInstallPromptEvent` the app uses. */
export interface DeferredInstallPrompt {
  prompt(): Promise<unknown>;
  readonly userChoice: Promise<{ readonly outcome: 'accepted' | 'dismissed' }>;
}

/** What a device reports about itself — read once at start (`browserInstallEnvironment`). */
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

const IOS_DEVICE = /\b(iPhone|iPad|iPod)\b/u;

export const installPlatform = (environment: InstallEnvironment): InstallPlatform => {
  if (environment.standaloneDisplay || environment.navigatorStandalone === true) return 'installed';
  // iPadOS 13+ announces itself as a Mac; only its touch screen gives it away.
  const iPadAsMac = /\bMacintosh\b/u.test(environment.userAgent) && environment.maxTouchPoints > 1;
  return IOS_DEVICE.test(environment.userAgent) || iPadAsMac ? 'ios' : 'browser';
};

/** Everything the banner and the Settings row decide from. */
export interface InstallPromptSnapshot {
  readonly platform: InstallPlatform;
  /** The browser has offered installation and the event is held. */
  readonly promptAvailable: boolean;
  /** The reader dismissed the offer on this device. */
  readonly dismissed: boolean;
  /** Installed during this visit (`appinstalled`, or an accepted prompt). */
  readonly installed: boolean;
}

/** The banner, if any: `prompt` (a button opens the browser's dialog) or `ios-hint` (where to tap). */
export type InstallBannerKind = 'prompt' | 'ios-hint';

export const installBanner = (snapshot: InstallPromptSnapshot): InstallBannerKind | null => {
  if (snapshot.installed || snapshot.platform === 'installed' || snapshot.dismissed) return null;
  if (snapshot.promptAvailable) return 'prompt';
  return snapshot.platform === 'ios' ? 'ios-hint' : null;
};

/**
 * What Settings › This device › Install app shows — never hidden by a dismissal, because that row is
 * where somebody who said "not now" goes when they change their mind.
 *
 *   `installed` — nothing to do; `prompt` — an Install button; `ios` — the Share sheet steps;
 *   `manual` — this browser has not offered it (yet), so say where its own menu keeps it.
 */
export type InstallSettingState = 'installed' | 'prompt' | 'ios' | 'manual';

export const installSetting = (snapshot: InstallPromptSnapshot): InstallSettingState => {
  if (snapshot.installed || snapshot.platform === 'installed') return 'installed';
  if (snapshot.promptAvailable) return 'prompt';
  return snapshot.platform === 'ios' ? 'ios' : 'manual';
};

/** The browser-local key a dismissal lives under. One device, one answer. */
export const INSTALL_DISMISSED_KEY = 'fy-install-dismissed-v1';

/** The two storage calls this needs. Either may throw (private mode, blocked storage). */
export interface InstallStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type InstallOutcome = 'accepted' | 'dismissed' | 'unavailable';

/**
 * The one place the held prompt and the dismissal live, observable for `useSyncExternalStore`.
 * A held prompt is single-use, by the browser's rule: whatever the reader answers, it is released.
 */
export class InstallPromptStore {
  readonly #storage: InstallStorage;
  readonly #listeners = new Set<() => void>();
  #prompt: DeferredInstallPrompt | null = null;
  #snapshot: InstallPromptSnapshot;

  constructor(platform: InstallPlatform, storage: InstallStorage) {
    this.#storage = storage;
    this.#snapshot = { platform, promptAvailable: false, dismissed: this.#readDismissed(), installed: false };
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly getSnapshot = (): InstallPromptSnapshot => this.#snapshot;

  /** The browser offered installation; keep the event for when the reader asks. */
  capture(prompt: DeferredInstallPrompt): void {
    this.#prompt = prompt;
    this.#update({ promptAvailable: true });
  }

  /** Opens the browser's own install dialog, once. */
  async install(): Promise<InstallOutcome> {
    const prompt = this.#prompt;
    if (prompt === null) return 'unavailable';
    this.#prompt = null;
    this.#update({ promptAvailable: false });
    await prompt.prompt();
    const { outcome } = await prompt.userChoice;
    if (outcome === 'accepted') this.markInstalled();
    return outcome;
  }

  /** The reader said "not now": remembered on this device, never asked again by the banner. */
  dismiss(): void {
    try {
      this.#storage.setItem(INSTALL_DISMISSED_KEY, '1');
    } catch {
      // Storage refused (private mode): the dismissal still holds for this visit.
    }
    this.#update({ dismissed: true });
  }

  markInstalled(): void {
    this.#prompt = null;
    this.#update({ installed: true, promptAvailable: false });
  }

  #readDismissed(): boolean {
    try {
      return this.#storage.getItem(INSTALL_DISMISSED_KEY) === '1';
    } catch {
      return false;
    }
  }

  #update(patch: Partial<InstallPromptSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch };
    for (const listener of this.#listeners) listener();
  }
}

/** The slice of `window` the install wiring listens on. */
export interface InstallEventTarget {
  addEventListener(type: 'beforeinstallprompt' | 'appinstalled', listener: (event: Event) => void): void;
}

/**
 * Listens for the browser's offer and for a finished install. `preventDefault` stops Chromium's own
 * mini-infobar, so the only offer the reader sees is the app's — the banner, or the Settings row.
 */
export const attachInstallPrompt = (store: InstallPromptStore, target: InstallEventTarget): void => {
  target.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    store.capture(event as unknown as DeferredInstallPrompt);
  });
  target.addEventListener('appinstalled', () => store.markInstalled());
};

/** The slice of `window` read once at start. */
export interface InstallWindow {
  readonly navigator: { readonly userAgent: string; readonly maxTouchPoints: number; readonly standalone?: boolean };
  matchMedia(query: string): { readonly matches: boolean };
  readonly localStorage: InstallStorage;
}

export const browserInstallEnvironment = (win: InstallWindow): InstallEnvironment => ({
  userAgent: win.navigator.userAgent,
  maxTouchPoints: win.navigator.maxTouchPoints,
  standaloneDisplay: win.matchMedia('(display-mode: standalone)').matches,
  navigatorStandalone: win.navigator.standalone,
});

/** Storage through a getter, so a page whose `localStorage` accessor itself throws still starts. */
export const browserInstallStorage = (win: InstallWindow): InstallStorage => ({
  getItem: key => win.localStorage.getItem(key),
  setItem: (key, value) => win.localStorage.setItem(key, value),
});

/** The production store: this device's platform, its storage, and the browser's events. */
export const createBrowserInstallPrompt = (win: InstallWindow & InstallEventTarget): InstallPromptStore => {
  const store = new InstallPromptStore(installPlatform(browserInstallEnvironment(win)), browserInstallStorage(win));
  attachInstallPrompt(store, win);
  return store;
};
