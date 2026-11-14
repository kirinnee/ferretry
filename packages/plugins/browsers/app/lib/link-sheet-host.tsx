/**
 * THE LINK SHEET, drawn once per machine by the frame (`ShellProvides.links` → `sheet`): the in-app preview a tap opens
 * while "Open links in" is the side panel, and the one polite line that says why a hand-off to this computer opened in
 * this browser instead. A tiny store carries both from the click handler, which is not React, to the sheet, which is.
 */

import type { ComponentType, ReactNode } from 'react';
import { useSyncExternalStore } from 'react';
import type { BrowserDestination } from '../features/browser/in-app-browser-model.ts';

interface LinkSheetState {
  readonly destination: BrowserDestination | null;
  readonly open: boolean;
  readonly notice: string;
}

const CLOSED: LinkSheetState = Object.freeze({ destination: null, open: false, notice: '' });

export class LinkSheetStore {
  #state: LinkSheetState = CLOSED;
  readonly #listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  snapshot = (): LinkSheetState => this.#state;

  open(destination: BrowserDestination): void {
    this.#set({ destination, open: true, notice: '' });
  }

  close(): void {
    this.#set({ ...this.#state, open: false });
  }

  say(notice: string): void {
    this.#set({ ...this.#state, notice });
  }

  #set(next: LinkSheetState): void {
    this.#state = next;
    for (const listener of this.#listeners) listener();
  }
}

export interface LinkSheetHostProps {
  readonly store: LinkSheetStore;
  readonly Sheet: ComponentType<{ destination: BrowserDestination; open: boolean; onClose: () => void }>;
}

export function LinkSheetHost({ store, Sheet }: LinkSheetHostProps): ReactNode {
  const state = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  return (
    <>
      {state.destination === null ? null : (
        <Sheet destination={state.destination} open={state.open} onClose={() => store.close()} />
      )}
      <p aria-atomic="true" aria-live="polite" className="sr-only" data-link-notice="" role="status">
        {state.notice}
      </p>
    </>
  );
}
