/**
 * What this machine remembers about the MCP servers it copied from itself (`<FY_HOME>/state/local-mcp-installs.json`).
 *
 * A SIBLING of the local skills' file and the catalog installs': one record per copy, with the SHA-256 of what it
 * wrote (a project's `.mcp.json` entry, or the stored fleet component), so a later remove or update finds a local
 * edit instead of overwriting it. It holds the NAMES of the secrets a copy was bound to, never a value.
 */
import {
  CatalogInstallTargetSchema,
  CatalogItemNameSchema,
  CatalogProvenanceSchema,
  CatalogSecretBindingsSchema,
  InstantSchema,
  LocalMcpInstallIdSchema,
  LocalMcpOriginSchema,
} from '@ferretry/protocol';
import { z } from 'zod';

const LOCAL_MCP_INSTALLS_SCHEMA_VERSION = 1 as const;

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);

const LocalMcpInstallRecordSchema = z.strictObject({
  installId: LocalMcpInstallIdSchema,
  installedAt: InstantSchema,
  name: CatalogItemNameSchema,
  /** Where it came from on this machine, as the inventory listed it. */
  origin: LocalMcpOriginSchema,
  /** The synthetic provenance a runtime install hands the fleet. Recorded so a replace matches it. */
  provenance: CatalogProvenanceSchema,
  target: CatalogInstallTargetSchema,
  destination: z.string().min(1),
  /** Where it lands, one value per place: two copies with the same key would overwrite each other. */
  key: z.string().min(1).max(4_200),
  /** Placeholder → the person's own secret it was bound to, or `null`. Names only. */
  secretBindings: CatalogSecretBindingsSchema,
  /** A project copy's normalised root, and the SHA-256 of the `.mcp.json` entry it wrote. */
  root: z.string().min(1).max(4_096).optional(),
  entrySha256: Sha256Schema.optional(),
  /** A runtime copy: the SHA-256 of the stored component, taken when it landed. */
  componentSha256: Sha256Schema.optional(),
});
export type LocalMcpInstallRecord = z.infer<typeof LocalMcpInstallRecordSchema>;

export const LocalMcpInstallStateSchema = z.strictObject({
  schemaVersion: z.literal(LOCAL_MCP_INSTALLS_SCHEMA_VERSION),
  installs: z.array(LocalMcpInstallRecordSchema),
});
export type LocalMcpInstallState = z.infer<typeof LocalMcpInstallStateSchema>;

export const EMPTY_LOCAL_MCP_INSTALL_STATE: LocalMcpInstallState = {
  schemaVersion: LOCAL_MCP_INSTALLS_SCHEMA_VERSION,
  installs: [],
};

/** The file could not be read as this daemon writes it. Never answered as "no copies". */
export class LocalMcpInstallStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalMcpInstallStateError';
  }
}

export interface LocalMcpInstallStore {
  /** The state; an empty one when there is no file yet. Throws {@link LocalMcpInstallStateError} on a damaged file. */
  read(): Promise<LocalMcpInstallState>;
  write(state: LocalMcpInstallState): Promise<void>;
}
