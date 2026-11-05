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
import { posix } from 'node:path';
import {
  CatalogInstallIdSchema,
  CatalogInstallTargetSchema,
  CatalogManifestProvenanceSchema,
  CatalogProvenanceSchema,
  CatalogSecretBindingsSchema,
  DaemonIdSchema,
  InstantSchema,
  isLinkProvenance,
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

/** The key of a link in `linkSequences`. */
export const linkSequenceKey = (publisher: string, linkId: string): string => `${publisher}/${linkId}`;

/** Why a version 2 document is refused. Fixed words: nothing from the file is in them. */
export const CATALOG_INSTALLS_DUPLICATE_INSTALL = 'two installs share one install id or one place';
export const CATALOG_INSTALLS_UNPINNED_LINK = 'a link install has no sequence pin at or above its own sequence';
export const CATALOG_INSTALLS_MISPLACED = 'an install is filed under a place other than the one it wrote to';

/** Every reason a version 2 document can be refused, so a caller can tell a contradiction from a malformed file. */
export const CATALOG_INSTALLS_CONTRADICTIONS: readonly string[] = [
  CATALOG_INSTALLS_DUPLICATE_INSTALL,
  CATALOG_INSTALLS_UNPINNED_LINK,
  CATALOG_INSTALLS_MISPLACED,
];

/** The server file of a project install. */
export const PROJECT_MCP_FILE = '.mcp.json';

/** A path as the service files it: normalised, without a trailing slash. */
export const withoutTrailingSlash = (path: string): string => posix.normalize(path).replace(/(?<=.)\/+$/u, '');

/** Where an install really is. `key` is its one-line identity; the rest is what removal works from. */
export type InstallPlace =
  | { readonly kind: 'runtime'; readonly key: string }
  | { readonly kind: 'server'; readonly key: string; readonly root: string; readonly entry: string }
  | { readonly kind: 'folder'; readonly key: string; readonly root: string; readonly folder: string };

/** A folder under a root that stays under it: relative, already canonical, never `.`, never leaving by `..`. */
const isContainedFolder = (folder: string): boolean =>
  folder !== '.' &&
  !posix.isAbsolute(folder) &&
  posix.normalize(folder) === folder &&
  !folder.endsWith('/') &&
  folder !== '..' &&
  !folder.startsWith('../');

/**
 * Where an install REALLY is, recomputed from what the record says it wrote (its root, folder, server entry, kind and
 * name), never from `key`. A project skill is its folder under its root; a project server is its entry in the root's
 * `.mcp.json`; a runtime item is its name in the fleet. The ONE function both the reader's validation and removal use,
 * so a record can never be filed under a place other than the one removal will touch.
 *
 * `undefined` when the record does not say enough, or says two things: a project record names a root and exactly one
 * of a server entry or a folder (both, or neither, is contradictory), a folder is canonical and stays under its root
 * (so `../app/x` under `/work/app` is refused rather than filed as a second spelling of `x`: root and folder joined are already canonical), and a runtime
 * record names neither a root nor a folder.
 */
export const installPlaceOf = (install: CatalogInstallRecord): InstallPlace | undefined => {
  if (install.target.scope === 'runtime') {
    if (install.root !== undefined || install.folder !== undefined) return undefined;
    return {
      kind: 'runtime',
      key: `fleet:${install.provenance.kind === 'mcp' ? 'mcp' : 'skills'}/${install.provenance.name}`,
    };
  }
  if (install.root === undefined) return undefined;
  const root = withoutTrailingSlash(install.root);
  const entry = install.files[0]?.entry;
  if (install.folder !== undefined) {
    if (entry !== undefined || !isContainedFolder(install.folder)) return undefined;
    return { kind: 'folder', key: `project:${root}/${install.folder}`, root, folder: install.folder };
  }
  if (entry === undefined) return undefined;
  return { kind: 'server', key: `project:${root}/${PROJECT_MCP_FILE}#${entry}`, root, entry };
};

/**
 * What a version 2 document says against itself. Three rules, all fail closed:
 *  - an install id and a place each belong to ONE record, or replacing either would drop the other;
 *  - each record's `key` is the place it really wrote to ({@link installPlaceOf}), so a variant spelling (`/./`) cannot
 *    make one physical install look like two, or hide it from the conflict check;
 *  - every link install is covered by a pin at or above its own sequence, or an older signed copy of that link
 *    would pass the sequence check and the next apply would write the pin back down.
 * Version 1 is not held to these: it has no pins, and is upgraded, never refused for lacking them. The reader refuses
 * a document with any of these, and the service asks BEFORE it installs anything, so what it writes is always readable.
 */
export const installStateProblems = (state: {
  readonly installs: readonly CatalogInstallRecord[];
  readonly linkSequences: Readonly<Record<string, number>>;
}): string[] => {
  const ids = new Set<string>();
  const keys = new Set<string>();
  let duplicated = false;
  let misplaced = false;
  let unpinned = false;
  for (const install of state.installs) {
    if (ids.has(install.installId) || keys.has(install.key)) duplicated = true;
    ids.add(install.installId);
    keys.add(install.key);
    if (installPlaceOf(install)?.key !== install.key) misplaced = true;
    const { provenance } = install;
    if (!isLinkProvenance(provenance)) continue;
    const pinned = state.linkSequences[linkSequenceKey(provenance.publisher, provenance.link.linkId)];
    if (pinned === undefined || pinned < provenance.link.sequence) unpinned = true;
  }
  return [
    ...(duplicated ? [CATALOG_INSTALLS_DUPLICATE_INSTALL] : []),
    ...(misplaced ? [CATALOG_INSTALLS_MISPLACED] : []),
    ...(unpinned ? [CATALOG_INSTALLS_UNPINNED_LINK] : []),
  ];
};

const refuseInconsistentState = (
  state: {
    readonly installs: readonly CatalogInstallRecord[];
    readonly linkSequences: Readonly<Record<string, number>>;
  },
  ctx: z.RefinementCtx,
): void => {
  for (const message of installStateProblems(state)) ctx.addIssue({ code: 'custom', message });
};

/** The file once a link has been installed from. */
export const CatalogInstallStateV2Schema = z
  .strictObject({
    schemaVersion: z.literal(CATALOG_INSTALLS_SCHEMA_VERSION_LINKS),
    installs: z.array(CatalogInstallRecordSchema),
    ...installStateFields,
    /** `<publisher>/<linkId>` → the highest signed sequence an install came from. A lower one is never accepted. */
    linkSequences: z.record(z.string().min(1).max(256), z.number().int().min(1).max(0xffffffff)),
  })
  .superRefine(refuseInconsistentState);

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
