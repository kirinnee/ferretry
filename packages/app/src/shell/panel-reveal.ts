/**
 * A PANEL THAT ASKS TO BE SHOWN (`PanelReveal`, `@ferretry/kernel/manifest`): the agent opened a page, so the Browser panel
 * should be on screen NOW (owner decision D-6). The manifest names the plugin's event and the `change` that asks; this
 * file is the one place that hears it and decides, so no plugin writes its own focus grab.
 *
 * - The ferret whose page is on screen: its panel is shown, and handed a `show-page` intent for the page.
 * - Any other ferret: nothing moves; that ferret is marked (`usePanelRevealMark`, the dot on its row).
 * - A PHONE with a sign-in card modal open: nothing moves either, the ferret is marked. A card the owner is typing a code into
 *   must never be replaced by a page. The modal says it is open with the attribute {@link CARD_MODAL_ATTRIBUTE}="open" on the
 *   document element (set while it is up, removed when it closes); this file reads that at the moment a page opens and nothing
 *   else about the modal, so it imports no vault code.
 */

import type { PanelIntent } from '@ferretry/kernel/manifest';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { PanelRef } from '../layout/engine.ts';
import { useOptionalShell } from './context.tsx';
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

const noSubscription = (): (() => void) => () => undefined;

/** Listens for every `reveal` the placed panels declare and acts on it. */
export function usePanelReveal({ daemon, subject, panels, phone, enabled, shown, onShow }: PanelRevealOptions): void {
  const runtime = useOptionalShell()?.runtime;
  const revealing = useMemo(() => panels.filter(panel => panel.reveal !== undefined), [panels]);
  // A plugin's client exists once its machine has connected; the listener below is attached then and not before.
  const ready = useSyncExternalStore(
    runtime?.subscribe ?? noSubscription,
    () => runtime !== undefined && revealing.every(panel => runtime.client(daemon, panel.plugin) !== undefined),
    () => false,
  );
  useEffect(() => {
    if (!enabled || !ready || runtime === undefined) return undefined;
    const cancels = revealing.flatMap(panel => {
      const reveal = panel.reveal;
      const client = runtime.client(daemon, panel.plugin);
      if (reveal === undefined || client === undefined) return [];
      return [
        client.subscribe(reveal.on, event => {
          if (event.change !== reveal.when) return;
          const key = panelKey(panel);
          const what = revealDecision({
            ferret: event.ferret,
            subject,
            phone,
            modalOpen: cardModalOpen(),
          });
          if (what === 'mark') {
            markUnseen(daemon, event.ferret, key);
            return;
          }
          clearUnseen(daemon, event.ferret, key);
          onShow(panel, { action: 'show-page', ...(event.page === undefined ? {} : { target: event.page }) });
        }),
      ];
    });
    return () => {
      for (const cancel of cancels) cancel();
    };
  }, [enabled, ready, runtime, daemon, subject, phone, revealing, onShow]);
  useEffect(() => {
    if (shown !== undefined) clearUnseen(daemon, subject, shown);
  }, [daemon, subject, shown]);
}
