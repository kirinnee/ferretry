/**
 * The app's install offer, read from the one `InstallPromptStore` the entry point created
 * (`main.tsx` — it has to exist before React mounts, because the browser's offer can arrive first).
 * `null` where no store was provided: a test, the component harness, or a page mounted without one —
 * every consumer then shows its no-offer state rather than inventing one.
 */

import { createContext, useContext, useSyncExternalStore } from 'react';
import type { InstallPromptSnapshot, InstallPromptStore } from '../lib/install-prompt.ts';

export const InstallPromptContext = createContext<InstallPromptStore | null>(null);

export interface InstallPromptView {
  readonly snapshot: InstallPromptSnapshot;
  readonly store: InstallPromptStore;
}

const noSubscription = (): (() => void) => () => undefined;
const noSnapshot = (): null => null;

export function useInstallPrompt(): InstallPromptView | null {
  const store = useContext(InstallPromptContext);
  const snapshot = useSyncExternalStore(store?.subscribe ?? noSubscription, store?.getSnapshot ?? noSnapshot);
  return store === null || snapshot === null ? null : { snapshot, store };
}
