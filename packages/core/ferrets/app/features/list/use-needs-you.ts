/**
 * WHO WAITS ON THE OWNER, live: the provider's answer (`ferrets.needs-you`), read for as long as the list is drawn.
 * Without a provider nobody is said to wait, and the list draws as it always did.
 */

import { useEffect, useSyncExternalStore } from 'react';
import type { FerretsNeedsYou } from '../../../contract/index.ts';
import type { NeedingYou } from './list-model.ts';

const NOBODY: NeedingYou = new Map();
const noSubscription = (): (() => void) => () => undefined;
const nobody = (): NeedingYou => NOBODY;

export function useNeedsYou(hook: FerretsNeedsYou | undefined): NeedingYou {
  useEffect(() => hook?.watch(), [hook]);
  return useSyncExternalStore(hook?.subscribe ?? noSubscription, hook?.needing ?? nobody, nobody);
}
