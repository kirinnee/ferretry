import { useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react';
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

export type PanelId = 'side' | 'ferret-side' | 'drawer' | 'settings-nav';

/** The allowed range of each panel, in screen pixels (the plan's: side column 280–640, drawer 220–400, settings nav 180–320). */
export const PANEL_RANGES: Readonly<Record<PanelId, { readonly min: number; readonly max: number }>> = {
  side: { min: 280, max: 640 },
  /** The ferret page's own side column (tabs: Console, Terminals, Browser…): wider than the list column, a terminal needs columns. */
  'ferret-side': { min: 300, max: 720 },
  drawer: { min: 220, max: 400 },
  'settings-nav': { min: 180, max: 320 },
};

/** The ferret page's chat keeps at least this much of its row (`shell.css` `--fy-chat-min`, the same number): the column's real room. */
const FERRET_CHAT_MIN = 320;

/** The panel's element, measured when a drag starts on a panel that has not been resized yet (its stylesheet width is the start). */
const PANEL_SELECTORS: Readonly<Record<PanelId, string>> = {
  side: '.fy-side',
  'ferret-side': '.fy-ferret-side',
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
  'ferret-side': z.number().finite().optional(),
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

/**
 * The most the panel can be drawn at right now: its range, held to the room its row leaves (the ferret page's column leaves the
 * chat `FERRET_CHAT_MIN`). Never below the range's minimum. A panel with no room limit has its range's maximum.
 */
export function measureMax(panel: PanelId): number {
  const { min, max } = PANEL_RANGES[panel];
  if (typeof document === 'undefined' || panel !== 'ferret-side') return max;
  const row = document.querySelector(PANEL_SELECTORS[panel])?.parentElement?.clientWidth ?? 0;
  return row <= 0 ? max : Math.max(min, Math.min(max, row - FERRET_CHAT_MIN));
}

/**
 * Below this window width the settings list no longer stands BESIDE the settings panel: it sits above it (`shell.css`, the
 * same number in its media query). Beside the drawer, a list and a panel need about 1040px; at 768px that left the panel
 * ~212px wide, so the list gives its column up and the panel gets the window.
 */
const SETTINGS_STACKED_BELOW = 1100;
/** The settings panel keeps at least this much room once the list is above it (a settings pane is unusable below it). */
const STACKED_MIN_PANE = 480;
/** The page beside the drawer and the settings list keeps at least this much room (a settings pane is unusable below it). */
const MIN_PANE = 320;
/** What the settings page spends besides the two panels and its pane: the page's side padding and the gap before the pane. */
const PANE_OVERHEAD = 56;
/** The same with the list stacked: only the page's side padding (no list column, no gap). */
const STACKED_OVERHEAD = 32;
/** What the stylesheet gives a panel nobody resized (screen pixels at text scale 1): the drawer is leaner while the list is stacked. */
const DEFAULT_WIDTH: Readonly<Record<'drawer' | 'settings-nav', number>> = { drawer: 280, 'settings-nav': 220 };
const STACKED_DRAWER_WIDTH = 240;

/**
 * THE SAVED WIDTHS, FITTED TO THIS SCREEN. A width saved on a wide screen (or one dragged to its maximum on a small one) must
 * not push the settings pane off a narrow window (768px: drawer 400 + list 320 left it 0 wide). When the drawer and the list
 * together leave the pane less than `MIN_PANE`, the SAVED ones shrink in proportion to how far each is above its own minimum,
 * never below it; an unsaved panel keeps the stylesheet's width and counts toward the sum. Below `SETTINGS_STACKED_BELOW` the
 * list is above the pane and takes no column, so only the drawer counts and the pane is kept `STACKED_MIN_PANE` wide. Below a
 * window where even the minimums leave the pane short the minimums are what remain. The stored value is untouched: widening the
 * window brings the chosen width back. Pure; `viewport` is the window's inner width.
 */
export function fitWidthsToViewport(widths: Widths, viewport: number): Widths {
  const stacked = viewport < SETTINGS_STACKED_BELOW;
  const panels = stacked ? (['drawer'] as const) : (['drawer', 'settings-nav'] as const);
  type Fitted = (typeof panels)[number];
  const budget = viewport - (stacked ? STACKED_OVERHEAD : PANE_OVERHEAD) - (stacked ? STACKED_MIN_PANE : MIN_PANE);
  const unsaved = (panel: Fitted): number =>
    stacked && panel === 'drawer' ? STACKED_DRAWER_WIDTH : DEFAULT_WIDTH[panel];
  const used = (panel: Fitted): number => widths[panel] ?? unsaved(panel);
  const excess = panels.reduce((sum, panel) => sum + used(panel), 0) - budget;
  if (excess <= 0) return widths;
  const room = (panel: Fitted): number =>
    widths[panel] === undefined ? 0 : Math.max(0, used(panel) - PANEL_RANGES[panel].min);
  const total = panels.reduce((sum, panel) => sum + room(panel), 0);
  if (total === 0) return widths;
  const share = Math.min(1, excess / total);
  const fitted: Widths = { ...widths };
  for (const panel of panels) {
    if (widths[panel] !== undefined) fitted[panel] = Math.round(used(panel) - room(panel) * share);
  }
  return fitted;
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
  // The window's width is part of the fit: a resize (or a rotation) re-fits the saved widths.
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  useLayoutEffect(() => {
    const onResize = (): void => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const fitted = useMemo(() => fitWidthsToViewport(widths, viewportWidth), [widths, viewportWidth]);
  useLayoutEffect(() => {
    applyPanelWidths(fitted, document.documentElement);
  }, [fitted]);
}
