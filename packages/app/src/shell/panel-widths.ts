import { useLayoutEffect, useSyncExternalStore } from 'react';
import { z } from 'zod';
import { APP_STORAGE } from '../storage/names.ts';
import { type KeyValueStore, readRecord, removeRecord, writeRecord } from '../storage/records.ts';

/**
 * HOW WIDE EACH RESIZABLE PANEL IS ON THIS DEVICE (r10 S3), remembered here and never on a daemon: a width is a taste of one screen.
 * The browser's storage holds one copy; a browser that refuses it keeps the visit's choice in memory and never throws. Shaped for
 * `useSyncExternalStore`, like the drawer's own state. A panel nobody resized has NO entry, so its stylesheet default applies.
 *
 * Each width is applied as a CSS variable on the document root (`--fy-w-<panel>`, in screen pixels). The stylesheets read it with
 * their own default as the fallback, so no panel needs a number here beyond its allowed range.
 */

export type PanelId = 'side' | 'drawer' | 'settings-nav';

/** The allowed range of each panel, in screen pixels (the plan's: side column 280–640, drawer 220–400, settings nav 180–320). */
export const PANEL_RANGES: Readonly<Record<PanelId, { readonly min: number; readonly max: number }>> = {
  side: { min: 280, max: 640 },
  drawer: { min: 220, max: 400 },
  'settings-nav': { min: 180, max: 320 },
};

/** The panel's element, measured when a drag starts on a panel that has not been resized yet (its stylesheet width is the start). */
const PANEL_SELECTORS: Readonly<Record<PanelId, string>> = {
  side: '.fy-side',
  drawer: '.fy-drawer',
  'settings-nav': '.fy-settings-nav',
};

const PANELS = Object.keys(PANEL_RANGES) as readonly PanelId[];

/** Keyboard step: ←/→ moves a panel's edge by this many pixels. */
export const KEY_STEP = 16;

/** The CSS variable a panel's width is applied through. */
const panelVar = (panel: PanelId): string => `--fy-w-${panel}`;

/** A width held inside the panel's range, rounded to a whole pixel. Not finite reads as the minimum. */
export function clampWidth(panel: PanelId, width: number): number {
  const { min, max } = PANEL_RANGES[panel];
  if (!Number.isFinite(width)) return min;
  return Math.min(max, Math.max(min, Math.round(width)));
}

const StoredSchema = z.strictObject({
  side: z.number().finite().optional(),
  drawer: z.number().finite().optional(),
  'settings-nav': z.number().finite().optional(),
});

type Widths = Partial<Record<PanelId, number>>;

/** The browser's local storage, or `null` when the browser will not hand it out. */
function deviceStorage(): KeyValueStore | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

class PanelWidthsState {
  readonly #listeners = new Set<() => void>();
  /** The choices of this visit (and of an in-progress drag, which is not stored until it ends). */
  #widths: Widths = {};
  #loaded = false;
  #snapshot: Widths = {};

  /** Every panel's width, stored values clamped (storage is a cache any page on the origin can write). */
  readonly all = (): Widths => {
    if (!this.#loaded) {
      this.#loaded = true;
      const stored = readRecord(deviceStorage(), APP_STORAGE.panelWidths, StoredSchema) ?? {};
      for (const panel of PANELS) {
        const width = stored[panel];
        if (width !== undefined) this.#widths[panel] = clampWidth(panel, width);
      }
      this.#snapshot = { ...this.#widths };
    }
    return this.#snapshot;
  };

  readonly width = (panel: PanelId): number | undefined => this.all()[panel];

  /** Shows a width now (a drag in progress) without storing it. */
  preview(panel: PanelId, width: number): void {
    this.all();
    this.#widths = { ...this.#widths, [panel]: clampWidth(panel, width) };
    this.#changed();
  }

  /** Shows a width and stores it. */
  set(panel: PanelId, width: number): void {
    this.preview(panel, width);
    this.#persist();
  }

  /** Stores what is showing (the end of a drag). */
  commit(): void {
    this.#persist();
  }

  /** Back to the stylesheet's own width for one panel. */
  reset(panel: PanelId): void {
    this.all();
    const { [panel]: _gone, ...rest } = this.#widths;
    this.#widths = rest;
    this.#changed();
    this.#persist();
  }

  /** Every panel back to its own width, nothing stored (and a test starts clean). */
  forget(): void {
    this.#widths = {};
    this.#loaded = false; // the next read goes to storage again
    removeRecord(deviceStorage(), APP_STORAGE.panelWidths);
    this.#snapshot = {};
    for (const listener of this.#listeners) listener();
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    // Another tab of this device resized a panel: take it on.
    const onStorage = (event: StorageEvent): void => {
      if (event.key !== null && event.key !== APP_STORAGE.panelWidths) return;
      this.#loaded = false;
      this.#widths = {};
      listener();
    };
    if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
    return () => {
      this.#listeners.delete(listener);
      if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
    };
  };

  #persist(): void {
    if (Object.keys(this.#widths).length === 0) removeRecord(deviceStorage(), APP_STORAGE.panelWidths);
    else writeRecord(deviceStorage(), APP_STORAGE.panelWidths, this.#widths);
  }

  #changed(): void {
    this.#snapshot = { ...this.#widths };
    for (const listener of this.#listeners) listener();
  }
}

/** The one the shell shares. */
export const panelWidths = new PanelWidthsState();

/** One panel's chosen width (`undefined`: its own), re-read when it changes. */
export function usePanelWidth(panel: PanelId): number | undefined {
  return useSyncExternalStore(
    panelWidths.subscribe,
    () => panelWidths.width(panel),
    () => undefined,
  );
}

/** Where a resize is measured from: the panel as drawn now. */
export function measurePanel(panel: PanelId): number | undefined {
  if (typeof document === 'undefined') return undefined;
  const width = document.querySelector(PANEL_SELECTORS[panel])?.getBoundingClientRect().width;
  return width === undefined || width <= 0 ? undefined : width;
}

/** Writes every stored width onto the document root as its CSS variable, and unsets a panel that has none. */
function applyPanelWidths(widths: Widths, root: HTMLElement): void {
  for (const panel of PANELS) {
    const width = widths[panel];
    if (width === undefined) root.style.removeProperty(panelVar(panel));
    else root.style.setProperty(panelVar(panel), `${width}px`);
  }
}

/**
 * Keeps the root's CSS variables in step with the stored widths. The frame mounts it once (the drawer does, it is always there);
 * a layout effect, so a stored width is on the page before the first paint and nothing jumps.
 */
export function useApplyPanelWidths(): void {
  const widths = useSyncExternalStore(panelWidths.subscribe, panelWidths.all, () => ({}) as Widths);
  useLayoutEffect(() => {
    applyPanelWidths(widths, document.documentElement);
  }, [widths]);
}
