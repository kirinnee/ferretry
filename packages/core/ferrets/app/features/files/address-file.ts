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

/** Addresses already acted on, so a Files panel that mounts again (a phone's chip) does not re-open what was closed. */
const handled = new Set<string>();

/**
 * The open request an address carries until it has been acted on (`markAddressHandled`), or `null`. Its sequence is 0,
 * below every request another panel makes (`open-request.ts` counts from 1), so a later request still wins. Pure: a
 * render that is drawn twice asks the same question twice.
 */
export const addressOpenRequest = (pathname: string, search: string): CodeReferenceOpenRequest | null => {
  const path = fileOfAddress(search);
  return path === null || handled.has(`${pathname}${search}`) ? null : { sequence: 0, reference: { path } };
};

/** Says the Files panel acted on this address's `?file=`. */
export const markAddressHandled = (pathname: string, search: string): void => {
  handled.add(`${pathname}${search}`);
};

/** Forgets what was acted on. Tests use it. */
export const resetAddressOpens = (): void => {
  handled.clear();
};
