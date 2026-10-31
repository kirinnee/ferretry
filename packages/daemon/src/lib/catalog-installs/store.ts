/**
 * What this machine remembers about the catalog items it installed (`<FY_HOME>/state/catalog-installs.json`).
 *
 * Four facts, all written only when an install lands: the installs themselves with the SHA-256 of
 * everything each one wrote (so an edit made here since is found, not overwritten), which publishers
 * this machine has installed from, which publisher each catalog is PINNED to, and the highest manifest
 * revision seen per catalog. A pin outlives the installs it came from: removing the last install of a
 * catalog does not make its next publisher a first one.
 */
import {
  CatalogInstallIdSchema,
  CatalogInstallTargetSchema,
  CatalogProvenanceSchema,
  CatalogSecretBindingsSchema,
  DaemonIdSchema,
  InstantSchema,
  SharedCatalogIdSchema,
} from '@ferretry/protocol';
import { z } from 'zod';

export const CATALOG_INSTALLS_SCHEMA_VERSION = 1 as const;

/** One thing an install wrote. `entry` names a server inside a shared `.mcp.json`; otherwise `path` is a whole file. */
export const CatalogInstalledFileSchema = z.strictObject({
  path: z.string().min(1).max(4_096),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  entry: z.string().min(1).max(64).optional(),
});
export type CatalogInstalledFile = z.infer<typeof CatalogInstalledFileSchema>;

export const CatalogInstallRecordSchema = z.strictObject({
  installId: CatalogInstallIdSchema,
  installedAt: InstantSchema,
  provenance: CatalogProvenanceSchema,
  target: CatalogInstallTargetSchema,
  destination: z.string().min(1),
  /** Where it lands, one value per place: two installs with the same key would overwrite each other. */
  key: z.string().min(1).max(4_200),
  files: z.array(CatalogInstalledFileSchema),
  secretBindings: CatalogSecretBindingsSchema,
  /**
   * A project skill's folder, relative to `root`, and the normalised root it was written under. Removal
   * works from these, never from the words in `destination`, so a root spelled with `/./` or a trailing
   * slash removes what was written.
   */
  root: z.string().min(1).max(4_096).optional(),
  folder: z.string().min(1).max(4_096).optional(),
  /**
   * A runtime install: the SHA-256 of the stored component in its canonical form, taken when it landed. A
   * hand edit (`fy config`) changes it even though the component still says where it came from.
   */
  componentSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/u)
    .optional(),
});
export type CatalogInstallRecord = z.infer<typeof CatalogInstallRecordSchema>;

export const CatalogInstallStateSchema = z.strictObject({
  schemaVersion: z.literal(CATALOG_INSTALLS_SCHEMA_VERSION),
  installs: z.array(CatalogInstallRecordSchema),
  /** Publisher daemon id → when this machine first installed from it. */
  publishers: z.record(DaemonIdSchema, InstantSchema),
  /** Catalog id → the one publisher it may be installed from. */
  pins: z.record(SharedCatalogIdSchema, DaemonIdSchema),
  /** Catalog id → the highest manifest revision an install came from. */
  revisions: z.record(SharedCatalogIdSchema, z.number().int().min(1)),
});
export type CatalogInstallState = z.infer<typeof CatalogInstallStateSchema>;

export const EMPTY_CATALOG_INSTALL_STATE: CatalogInstallState = {
  schemaVersion: CATALOG_INSTALLS_SCHEMA_VERSION,
  installs: [],
  publishers: {},
  pins: {},
  revisions: {},
};

/** The file could not be read as this daemon writes it. Never answered as "no installs". */
export class CatalogInstallStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogInstallStateError';
  }
}

export interface CatalogInstallStore {
  /** The state; an empty one when there is no file yet. Throws {@link CatalogInstallStateError} on a damaged file. */
  read(): Promise<CatalogInstallState>;
  write(state: CatalogInstallState): Promise<void>;
}
