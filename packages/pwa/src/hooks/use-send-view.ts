import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { nextSettledChange } from '../lib/ledger-placement.ts';
import { SendDismissalStore, type SendViewState } from '../lib/send-dismissals.ts';
import type { LedgerSendRecord } from '../lib/send-ledger.ts';

/** This device's one store of dismissed sends; every conversation on the page shares it. */
const deviceDismissals = new SendDismissalStore();

export interface SendView {
  readonly view: SendViewState;
  /** Changes whenever a settled row folds or retires on its own, so a memo over `Date.now()` is redone. */
  readonly tick: number;
  readonly dismiss: (sendIds: readonly string[]) => void;
  readonly setExpanded: (sendId: string, open: boolean) => void;
}

/**
 * What this device has put away or opened, and the clock the settled rows change on: one wake-up at the
 * next moment a fresh bubble folds to its note or a note retires, never a poll.
 */
export function useSendView(
  sends: readonly LedgerSendRecord[],
  store: SendDismissalStore = deviceDismissals,
): SendView {
  const view = useSyncExternalStore(store.subscribe, store.snapshot);
  const [tick, setTick] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` re-arms the timer after it fires.
  useEffect(() => {
    const at = nextSettledChange(sends, Date.now(), view);
    if (at === undefined) return;
    const timer = setTimeout(() => setTick(current => current + 1), Math.max(0, at - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [sends, view, tick]);
  const dismiss = useCallback((sendIds: readonly string[]) => store.dismiss(sendIds), [store]);
  const setExpanded = useCallback((sendId: string, open: boolean) => store.setExpanded(sendId, open), [store]);
  return { view, tick, dismiss, setExpanded };
}
