/**
 * THIS COPY OF THE APP'S OWN RELEASE VERSION, and the one-time "Ferretry updated" line.
 *
 * The build stamps the repository's `VERSION` (the release semantic-release last cut) into
 * `__FY_APP_VERSION__` (`vite.config.ts`), the same number the signed release list carries. A build
 * that has none — a test, a harness that never defined it — answers `undefined`, and every reader says
 * so rather than inventing a version.
 *
 * "App updated" is decided from what THIS browser saw last, not from the service worker's swap: the
 * swap is what puts a new version in front of the next load, and the next load is the first moment a
 * different number can be read here. Storage that throws or is absent says nothing, ever — a private
 * window must not announce an update on every load.
 */

import { compareProtocolVersions } from '@ferretry/protocol';

declare const __FY_APP_VERSION__: string | undefined;

/** The version this build was stamped with, or `undefined` when it was stamped with none. */
export function appVersion(): string | undefined {
  const stamped = typeof __FY_APP_VERSION__ === 'string' ? __FY_APP_VERSION__.trim() : '';
  return stamped === '' ? undefined : stamped;
}

/** The slice of `localStorage` the notice uses. */
export interface AppVersionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const LAST_SEEN_KEY = 'fy-app-version-seen-v1';

/** `localStorage`, or nothing: reading the property itself throws in some private modes. */
export function browserAppVersionStorage(): AppVersionStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * The version to announce as "updated to", at most once per version per browser — or `null`.
 *
 * Records `current` as seen either way. Only a NEWER version than the last one seen is announced: the
 * first load ever has nothing to compare with, and a rollback is not news worth a toast.
 */
export function takeAppUpdatedNotice(
  storage: AppVersionStorage | undefined,
  current: string | undefined,
): string | null {
  if (storage === undefined || current === undefined) return null;
  try {
    const seen = storage.getItem(LAST_SEEN_KEY);
    if (seen !== current) storage.setItem(LAST_SEEN_KEY, current);
    return seen !== null && compareProtocolVersions(current, seen) === 1 ? current : null;
  } catch {
    return null;
  }
}

/** The toast's sentence. */
export const appUpdatedWords = (version: string): string => `Ferretry updated to ${version}.`;
