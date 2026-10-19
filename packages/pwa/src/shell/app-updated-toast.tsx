/**
 * "FERRETRY UPDATED TO vX", ONCE: the load after the signed service worker swapped in a new release.
 *
 * The decision is `takeAppUpdatedNotice` (`lib/app-version.ts`), made once when this mounts; the toast
 * is the Actions toast, so it looks, announces and dismisses itself the same way.
 */

import { useCallback, useState } from 'react';
import { ActionToast } from '../features/session-actions/action-toast.tsx';
import {
  type AppVersionStorage,
  appUpdatedWords,
  appVersion,
  browserAppVersionStorage,
  takeAppUpdatedNotice,
} from '../lib/app-version.ts';

export interface AppUpdatedToastProps {
  /** Seams for tests; the browser's storage and this build's version otherwise. */
  readonly storage?: AppVersionStorage | undefined;
  readonly version?: string | undefined;
}

export function AppUpdatedToast(props: AppUpdatedToastProps) {
  const [updated, setUpdated] = useState(() =>
    takeAppUpdatedNotice(
      'storage' in props ? props.storage : browserAppVersionStorage(),
      'version' in props ? props.version : appVersion(),
    ),
  );
  const dismiss = useCallback(() => setUpdated(null), []);
  return <ActionToast notice={updated === null ? null : appUpdatedWords(updated)} onDismiss={dismiss} />;
}
