/**
 * The accounts a ferret could be moved onto in the OTHER harness, read from the machine's roster.
 *
 * The store is optional because the page that hosts the Actions menu may be mounted without one; the
 * hooks still run unconditionally and the answer is then "none", which hides the row rather than
 * offering a move that cannot be completed.
 */

import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import type { PickerAccount } from '../../lib/account-picker-catalog.ts';
import type { DaemonAccountPickerStore } from '../../lib/account-picker-store.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { useConfigChangeEffect } from '../../lib/store.tsx';
import type { HarnessKind } from '../fleet/credentials/credentials-model.ts';
import { convertibleAccounts } from './conversion-model.ts';

const KINDS = ['credentials', 'runtimes'] as const;
const NONE: readonly PickerAccount[] = Object.freeze([]);

export const useConvertibleAccounts = (
  store: DaemonAccountPickerStore | undefined,
  connection: DaemonConnection,
  harness: HarnessKind,
): readonly PickerAccount[] => {
  const subscribe = useCallback(
    (listener: () => void) => (store === undefined ? () => undefined : store.subscribe(listener)),
    [store],
  );
  const read = useCallback(() => store?.sliceFor(connection) ?? null, [store, connection]);
  const slice = useSyncExternalStore(subscribe, read, read);
  useEffect(() => {
    if (store !== undefined) void store.hydrate(connection).catch(() => {});
  }, [store, connection]);
  useConfigChangeEffect(connection.daemonId, KINDS, () => store?.reread(connection));
  const accounts = slice?.catalog?.accounts;
  return useMemo(() => (accounts === undefined ? NONE : convertibleAccounts(accounts, harness)), [accounts, harness]);
};
