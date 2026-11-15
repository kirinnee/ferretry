/**
 * OFFERING TO INSTALL FERRETRY AS AN APP — whether to offer it, and the dismissal that stops the nagging.
 *
 * The browser's own facts (is this iOS, is it already installed, did Chromium hold a `beforeinstallprompt`) belong to
 * the app shell, which captures them at boot and serves them through `useInstallPrompt` (shell contract S13). Nothing
 * here listens to the browser or reads the device: this file only DECIDES, from what the shell says, which offer to
 * make — and remembers, on this device, that the reader said "not now".
 *
 * Nothing is offered to an app that is ALREADY running installed, and a dismissal is remembered on this device, so
 * the toast is made once and never nags. Settings › This device › Install app stays available either way.
 */

import type { InstallPlatform } from '@ferretry/app';

/** What the shell reports of the install prompt — the slice the offer decides from. */
export interface InstallFacts {
  readonly platform: InstallPlatform;
  /** Chromium has offered installation and the event is still held. */
  readonly canPrompt: boolean;
}

/** The toast, if any: `prompt` (a button opens the browser's dialog) or `ios-hint` (where to tap). */
export type InstallToastKind = 'prompt' | 'ios-hint';

export const installToast = (facts: InstallFacts, dismissed: boolean): InstallToastKind | null => {
  if (facts.platform === 'installed' || dismissed) return null;
  if (facts.canPrompt) return 'prompt';
  return facts.platform === 'ios' ? 'ios-hint' : null;
};

/**
 * What Settings › This device › Install app shows — never hidden by a dismissal, because that row is where somebody
 * who said "not now" goes when they change their mind.
 *
 *   `installed` — nothing to do; `prompt` — an Install button; `ios` — the Share sheet steps;
 *   `manual` — this browser has not offered it (yet), so say where its own menu keeps it.
 */
export type InstallSettingState = 'installed' | 'prompt' | 'ios' | 'manual';

export const installSetting = (facts: InstallFacts): InstallSettingState => {
  if (facts.platform === 'installed') return 'installed';
  if (facts.canPrompt) return 'prompt';
  return facts.platform === 'ios' ? 'ios' : 'manual';
};

/**
 * Whether this machine's mount of the toast is the one that draws it. The shell mounts a background view once per
 * paired machine, but the offer is this device's: the FIRST paired machine speaks for it, so two machines never stack
 * two toasts.
 */
export const speaksForDevice = (paired: readonly string[], daemon: string): boolean => paired[0] === daemon;

/** The browser-local key a dismissal lives under. One device, one answer. */
export const INSTALL_DISMISSED_KEY = 'fy-install-dismissed-v1';

/** The two storage calls this needs. Either may throw (private mode, blocked storage). */
export interface InstallStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The slice of `window` the dismissal reads its storage from. */
export interface InstallWindow {
  readonly localStorage: InstallStorage;
}

/** Storage through a getter, so a page whose `localStorage` accessor itself throws still starts. */
export const browserInstallStorage = (win: InstallWindow): InstallStorage => ({
  getItem: key => win.localStorage.getItem(key),
  setItem: (key, value) => win.localStorage.setItem(key, value),
});

/**
 * Whether the reader dismissed the offer on this device — observable for `useSyncExternalStore`, so the toast and the
 * Settings row (two views, one device) always agree.
 */
export class InstallDismissal {
  readonly #storage: InstallStorage;
  readonly #listeners = new Set<() => void>();
  #dismissed: boolean;

  constructor(storage: InstallStorage) {
    this.#storage = storage;
    this.#dismissed = this.#read();
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly getSnapshot = (): boolean => this.#dismissed;

  /** The reader said "not now": remembered on this device, never offered again by the toast. */
  readonly dismiss = (): void => {
    try {
      this.#storage.setItem(INSTALL_DISMISSED_KEY, '1');
    } catch {
      // Storage refused (private mode): the dismissal still holds for this visit.
    }
    this.#dismissed = true;
    for (const listener of this.#listeners) listener();
  };

  #read(): boolean {
    try {
      return this.#storage.getItem(INSTALL_DISMISSED_KEY) === '1';
    } catch {
      return false;
    }
  }
}
