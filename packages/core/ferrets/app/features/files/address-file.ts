/**
 * "OPEN THIS FILE" FROM AN ADDRESS (`/d/<daemon>/ferrets/<id>?file=<path>`): how a page that is not a panel of this ferret
 * (Projects' file finder, its command bar's Go to file) lands on one file of the ferret's folder. The address names a path
 * relative to the ferret's folder and nothing else: the Files panel opens it through its own gated read, so the daemon still
 * decides whether it may be read, exactly as it does for a click inside Files. A path that is absolute, climbs (`..`) or
 * carries a backslash or control character is not a path here and opens nothing.
 */
import { codeReferenceRelativePath } from '../../../contract/index.ts';
import type { CodeReferenceOpenRequest } from './files-tab-model.ts';

/** The folder-relative path an address's query names, or `null` (none, or one that cannot be opened). */
export const fileOfAddress = (search: string): string | null => {
  const named = new URLSearchParams(search).get('file');
  return named === null ? null : codeReferenceRelativePath(named);
};

/**
 * What was acted on is remembered per NAVIGATION — the history entry (`entry`, the router's `entryKey`: stable across
 * Back, Forward and a remount of the panel, new on every push) AND the address — never per address alone. A Files panel
 * that mounts again within the same navigation (a phone's chip) must not re-open what was closed; but a fresh explicit
 * navigation to an address already visited earlier (src/entry.ts, then src/entry-ts, then src/entry.ts again) is a new
 * entry and always opens its file. `entry` is `''` where no router is mounted.
 */
const handled = new Set<string>();

const navigationKey = (entry: string, pathname: string, search: string): string => `${entry}\n${pathname}${search}`;

/**
 * The open request an address carries until it has been acted on (`markAddressHandled`) in this navigation, or `null`.
 * Its sequence is 0, below every request another panel makes (`open-request.ts` counts from 1), so a later request still
 * wins. Pure: a render that is drawn twice asks the same question twice.
 */
export const addressOpenRequest = (
  entry: string,
  pathname: string,
  search: string,
): CodeReferenceOpenRequest | null => {
  const path = fileOfAddress(search);
  return path === null || handled.has(navigationKey(entry, pathname, search))
    ? null
    : { sequence: 0, reference: { path } };
};

/** Says the Files panel acted on this navigation's `?file=`. */
export const markAddressHandled = (entry: string, pathname: string, search: string): void => {
  handled.add(navigationKey(entry, pathname, search));
};

/** Forgets what was acted on. Tests use it. */
export const resetAddressOpens = (): void => {
  handled.clear();
};
