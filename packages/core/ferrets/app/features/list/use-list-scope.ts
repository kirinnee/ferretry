/**
 * THE LIST'S FOCUS, live: the provider's answer (`ferrets.list-scope`), read for as long as the list is drawn. Without a
 * provider the list has no focus and groups by folder, as it always did.
 */

import { useEffect, useSyncExternalStore } from 'react';
import type { FerretListScopeSnapshot, FerretsListScope } from '../../../contract/index.ts';

const NO_SCOPE: FerretListScopeSnapshot = { scope: null, known: true, groupOf: () => null };
const noSubscription = (): (() => void) => () => undefined;
const noScope = (): FerretListScopeSnapshot => NO_SCOPE;

export function useListScope(hook: FerretsListScope | undefined): FerretListScopeSnapshot {
  useEffect(() => hook?.watch(), [hook]);
  return useSyncExternalStore(hook?.subscribe ?? noSubscription, hook?.snapshot ?? noScope, noScope);
}
