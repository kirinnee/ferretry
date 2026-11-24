/**
 * A PANEL THAT ASKS TO BE SHOWN: the agent opened a page, so the Browser panel should be on screen NOW (owner decision D-6).
 * Two halves, so that nothing depends on a chat being open:
 *
 * - THE LISTENER is the plugin's. It runs app-wide, once per machine (`ShellProvides.background`), hears its own event and
 *   calls {@link announcePanelReveal}. It exists on every page, so a ferret's row gets its dot on the ferrets list as well.
 * - THE WORKSPACE is this file's consumer: a ferret page that is on screen {@link usePanelReveal | registers} for its own
 *   ferret and decides. No workspace takes the announcement, so no plugin writes its own focus grab.
 *
 * What a workspace does with an announcement:
 * - The ferret whose page is on screen: its panel is shown, and handed a `show-page` intent for the page.
 * - Any other ferret, or no workspace at all: nothing moves; that ferret is marked (`usePanelRevealMark`, the dot on its row).
 * - A PHONE with a sign-in card modal open: nothing moves either, the ferret is marked. A card the owner is typing a code into
 *   must never be replaced by a page. The modal says it is open with the attribute {@link CARD_MODAL_ATTRIBUTE}="open" on the
 *   document element (set while it is up, removed when it closes); this file reads that at the moment a page opens and nothing
 *   else about the modal, so it imports no vault code.
 */

import type { PanelIntent } from '@ferretry/kernel/manifest';
import { useEffect, useSyncExternalStore } from 'react';
import type { PanelRef } from '../layout/engine.ts';
import { panelKey } from './ferret-workspace-model.ts';

/** A tiny observable, shaped for `useSyncExternalStore`. */
class Signal<T> {
  readonly #listeners = new Set<() => void>();
  #value: T;
  constructor(initial: T) {
    this.#value = initial;
  }
  readonly get = (): T => this.#value;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  set(value: T): void {
    if (Object.is(value, this.#value)) return;
    this.#value = value;
    for (const listener of [...this.#listeners]) listener();
  }
}

/** Set on the document element by the sign-in card modal while it is open (the vault owns the modal; this is its whole contract). */
export const CARD_MODAL_ATTRIBUTE = 'data-fy-input-modal';

/** Whether a sign-in card modal is open on this device right now. */
const cardModalOpen = (): boolean => globalThis.document?.documentElement.getAttribute(CARD_MODAL_ATTRIBUTE) === 'open';

/** What a reveal does. Pure: the deciding rule, with every input named. */
export function revealDecision(input: {
  readonly ferret: string;
  readonly subject: string;
  readonly phone: boolean;
  readonly modalOpen: boolean;
}): 'show' | 'mark' {
  if (input.ferret !== input.subject) return 'mark';
  return input.phone && input.modalOpen ? 'mark' : 'show';
}

const unseen = new Signal<ReadonlySet<string>>(new Set());
const unseenKey = (daemon: string, ferret: string, panel: string): string => `${daemon}\u0000${ferret}\u0000${panel}`;

function markUnseen(daemon: string, ferret: string, panel: string): void {
  unseen.set(new Set([...unseen.get(), unseenKey(daemon, ferret, panel)]));
}
function clearUnseen(daemon: string, ferret: string, panel: string): void {
  const key = unseenKey(daemon, ferret, panel);
  if (!unseen.get().has(key)) return;
  const next = new Set(unseen.get());
  next.delete(key);
  unseen.set(next);
}

/** Whether something this ferret's panels asked to show has not been seen yet (the dot on its row). */
export function usePanelRevealMark(daemon: string, ferret: string): boolean {
  const prefix = `${daemon}\u0000${ferret}\u0000`;
  const read = (): boolean => [...unseen.get()].some(key => key.startsWith(prefix));
  return useSyncExternalStore(unseen.subscribe, read, read);
}

/** What a plugin's listener announces: on this machine, this ferret's panel (`browsers.browser`) wants to be shown, for this page. */
export interface PanelRevealEvent {
  readonly daemon: string;
  readonly ferret: string;
  /** The panel key (`plugin.id`). */
  readonly panel: string;
  /** What it is about, when it is about one thing (the page id). */
  readonly page?: string;
}

/** The workspaces on screen. A sink answers whether it took the announcement. */
const sinks = new Set<(event: PanelRevealEvent) => boolean>();

/**
 * A plugin's listener says a panel wants to be shown. The ferret's own workspace, when one is on screen, shows it (or marks
 * the ferret); with none, the ferret is marked, so the dot is there on pages that have no chat.
 */
export function announcePanelReveal(event: PanelRevealEvent): void {
  let taken = false;
  for (const sink of [...sinks]) if (sink(event)) taken = true;
  if (!taken) markUnseen(event.daemon, event.ferret, event.panel);
}

export interface PanelRevealOptions {
  readonly daemon: string;
  /** The ferret whose page this workspace is. */
  readonly subject: string;
  readonly panels: readonly PanelRef[];
  readonly phone: boolean;
  /** Counts only while this workspace is the one drawing the panels (the wide page, or the phone's, never both). */
  readonly enabled: boolean;
  /** The panel key (`browsers.browser`) now on screen, or undefined: seeing it clears its mark. */
  readonly shown: string | undefined;
  /** Brings the panel on screen and hands it the intent. */
  readonly onShow: (panel: PanelRef, intent: Pick<PanelIntent, 'action' | 'target'>) => void;
}

/** Takes the announcements for this workspace's ferret and acts on them. */
export function usePanelReveal({ daemon, subject, panels, phone, enabled, shown, onShow }: PanelRevealOptions): void {
  useEffect(() => {
    if (!enabled) return undefined;
    const sink = (event: PanelRevealEvent): boolean => {
      if (event.daemon !== daemon || event.ferret !== subject) return false;
      const panel = panels.find(candidate => panelKey(candidate) === event.panel);
      if (panel === undefined) return false;
      if (revealDecision({ ferret: event.ferret, subject, phone, modalOpen: cardModalOpen() }) === 'mark') {
        markUnseen(daemon, event.ferret, event.panel);
        return true;
      }
      clearUnseen(daemon, event.ferret, event.panel);
      onShow(panel, { action: 'show-page', ...(event.page === undefined ? {} : { target: event.page }) });
      return true;
    };
    sinks.add(sink);
    return () => {
      sinks.delete(sink);
    };
  }, [enabled, daemon, subject, phone, panels, onShow]);
  useEffect(() => {
    if (shown !== undefined) clearUnseen(daemon, subject, shown);
  }, [daemon, subject, shown]);
}
