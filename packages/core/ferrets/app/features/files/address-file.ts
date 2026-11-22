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
 * Only the LAST navigation acted on is remembered: its history entry (`entry`, the router's `entryKey`: stable across a
 * remount of the panel, new on every push, restored by Back and Forward) AND its address. An address is applied whenever
 * its (entry + address) is not the one last applied — a fresh navigation, a revisit of an address seen before, and a
 * Back or Forward that restores an earlier entry all differ from it — while a panel that mounts again within the same
 * navigation (a phone's chip) must not re-open what was closed. No set: a set would suppress every restored entry.
 * `entry` is `''` where no router is mounted.
 */
let lastApplied: string | null = null;

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
  return path === null || lastApplied === navigationKey(entry, pathname, search)
    ? null
    : { sequence: 0, reference: { path } };
};

/** Says the Files panel acted on this navigation's `?file=` (and forgets the one before it). */
export const markAddressHandled = (entry: string, pathname: string, search: string): void => {
  lastApplied = navigationKey(entry, pathname, search);
};

/** Forgets what was acted on. Tests use it. */
export const resetAddressOpens = (): void => {
  lastApplied = null;
};
