/**
 * What this machine remembers about the catalog items it installed (`<FY_HOME>/state/catalog-installs.json`).
 *
 * Four facts, all written only when an install lands: the installs themselves with the SHA-256 of
 * everything each one wrote (so an edit made here since is found, not overwritten), which publishers
 * this machine has installed from, which publisher each catalog is PINNED to, and the highest manifest
 * revision seen per catalog. A pin outlives the installs it came from: removing the last install of a
 * catalog does not make its next publisher a first one.
 *
 * Two versions of the file. Version 1 is what every daemon wrote until a LINK was first installed from; version 2
 * adds `linkSequences` (the highest signed sequence installed from each link) and lets an install's provenance
 * name a link. The upgrade happens ONLY inside the first link install's write, after the adapter has kept the exact
 * old text as `catalog-installs.v1.json`; a daemon that does not know version 2 refuses the file (its schema is a
 * literal 1) and never writes over it. A machine that never installs from a link never leaves version 1.
 */
import {
  CatalogInstallIdSchema,
  CatalogInstallTargetSchema,
  CatalogManifestProvenanceSchema,
  CatalogProvenanceSchema,
  CatalogSecretBindingsSchema,
  DaemonIdSchema,
  InstantSchema,
  SharedCatalogIdSchema,
} from '@ferretry/protocol';
import { z } from 'zod';

export const CATALOG_INSTALLS_SCHEMA_VERSION = 1 as const;
export const CATALOG_INSTALLS_SCHEMA_VERSION_LINKS = 2 as const;

/** One thing an install wrote. `entry` names a server inside a shared `.mcp.json`; otherwise `path` is a whole file. */
export const CatalogInstalledFileSchema = z.strictObject({
  path: z.string().min(1).max(4_096),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  entry: z.string().min(1).max(64).optional(),
});
export type CatalogInstalledFile = z.infer<typeof CatalogInstalledFileSchema>;

const installRecordFields = {
  installId: CatalogInstallIdSchema,
  installedAt: InstantSchema,
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
};

/** An install as version 1 of the file holds it: always from a catalog. */
const CatalogInstallRecordV1Schema = z.strictObject({
  ...installRecordFields,
  provenance: CatalogManifestProvenanceSchema,
});

/** An install as this daemon holds and lists it: from a catalog or from a link. */
export const CatalogInstallRecordSchema = z.strictObject({
  ...installRecordFields,
  provenance: CatalogProvenanceSchema,
});
export type CatalogInstallRecord = z.infer<typeof CatalogInstallRecordSchema>;

const installStateFields = {
  /** Publisher daemon id → when this machine first installed from it. */
  publishers: z.record(DaemonIdSchema, InstantSchema),
  /** Catalog id → the one publisher it may be installed from. */
  pins: z.record(SharedCatalogIdSchema, DaemonIdSchema),
  /** Catalog id → the highest manifest revision an install came from. */
  revisions: z.record(SharedCatalogIdSchema, z.number().int().min(1)),
};

/** The file as every daemon wrote it before links. Kept so a v1 file is read exactly, and so a v2 file is provably not a v1 one. */
export const CatalogInstallStateV1Schema = z.strictObject({
  schemaVersion: z.literal(CATALOG_INSTALLS_SCHEMA_VERSION),
  installs: z.array(CatalogInstallRecordV1Schema),
  ...installStateFields,
});

/** The file once a link has been installed from. */
export const CatalogInstallStateV2Schema = z.strictObject({
  schemaVersion: z.literal(CATALOG_INSTALLS_SCHEMA_VERSION_LINKS),
  installs: z.array(CatalogInstallRecordSchema),
  ...installStateFields,
  /** `<publisher>/<linkId>` → the highest signed sequence an install came from. A lower one is never accepted. */
  linkSequences: z.record(z.string().min(1).max(256), z.number().int().min(1).max(0xffffffff)),
});

/** Either version, as found on disk. */
export const CatalogInstallStateSchema = z.union([CatalogInstallStateV1Schema, CatalogInstallStateV2Schema]);

/** The state as the service holds it: `linkSequences` is there exactly when the version is 2. */
export interface CatalogInstallState {
  readonly schemaVersion: 1 | 2;
  readonly installs: readonly CatalogInstallRecord[];
  readonly publishers: Readonly<Record<string, string>>;
  readonly pins: Readonly<Record<string, string>>;
  readonly revisions: Readonly<Record<string, number>>;
  readonly linkSequences?: Readonly<Record<string, number>>;
}

/** The key of a link in `linkSequences`. */
export const linkSequenceKey = (publisher: string, linkId: string): string => `${publisher}/${linkId}`;

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
