/**
 * What the person chose to do about FUTURE versions of an install (`<FY_HOME>/state/catalog-install-prefs.json`):
 * hold it where it is, or skip one version. Kept apart from `catalog-installs.json`, which records what was
 * written and stays at version 1. Nothing here ever acts on its own: a hold or a skip only changes what a reader
 * SAYS about an install, and an update is always the person's act.
 */
import { CatalogInstallIdSchema, type CatalogInstallPrefsRequest } from '@ferretry/protocol';
import { z } from 'zod';

const CATALOG_INSTALL_PREFS_SCHEMA_VERSION = 1 as const;

const CatalogInstallPrefSchema = z.strictObject({
  hold: z.literal(true).optional(),
  skippedVersion: z.number().int().min(1).optional(),
});
export type CatalogInstallPref = z.infer<typeof CatalogInstallPrefSchema>;

export const CatalogInstallPrefsStateSchema = z.strictObject({
  schemaVersion: z.literal(CATALOG_INSTALL_PREFS_SCHEMA_VERSION),
  installs: z.record(CatalogInstallIdSchema, CatalogInstallPrefSchema),
});
export type CatalogInstallPrefsState = z.infer<typeof CatalogInstallPrefsStateSchema>;

export const EMPTY_CATALOG_INSTALL_PREFS: CatalogInstallPrefsState = {
  schemaVersion: CATALOG_INSTALL_PREFS_SCHEMA_VERSION,
  installs: {},
};

export interface CatalogInstallPrefsStore {
  /** The prefs; an empty set when there is no file yet. Throws a `CatalogInstallStateError` on a damaged file. */
  read(): Promise<CatalogInstallPrefsState>;
  write(state: CatalogInstallPrefsState): Promise<void>;
}

/** The pref after a request: `hold: false` and `skippedVersion: null` clear; what the request leaves out stays. */
export function mergedPref(
  current: CatalogInstallPref | undefined,
  request: CatalogInstallPrefsRequest,
): CatalogInstallPref {
  const hold = request.hold === undefined ? current?.hold === true : request.hold;
  const skippedVersion =
    request.skippedVersion === undefined ? current?.skippedVersion : (request.skippedVersion ?? undefined);
  return { ...(hold ? { hold: true as const } : {}), ...(skippedVersion === undefined ? {} : { skippedVersion }) };
}

/** `state` with the install's pref set, or removed when nothing is left of it. */
export function withPref(
  state: CatalogInstallPrefsState,
  installId: string,
  pref: CatalogInstallPref,
): CatalogInstallPrefsState {
  const { [installId]: _gone, ...rest } = state.installs;
  const empty = pref.hold === undefined && pref.skippedVersion === undefined;
  return { ...state, installs: empty ? rest : { ...rest, [installId]: pref } };
}
