/**
 * What this machine remembers about the skills it copied from itself (`<FY_HOME>/state/local-skill-installs.json`).
 *
 * A SIBLING of the catalog installs' file, with the same shape for what matters: one record per copy, with
 * the SHA-256 of every file it wrote, so a later remove or update finds a local edit instead of overwriting it.
 * Nothing here is a catalog's: no publisher, no pin, no revision.
 */
import {
  CatalogInstallTargetSchema,
  CatalogProvenanceSchema,
  InstantSchema,
  LocalSkillInstallIdSchema,
  LocalSkillOriginSchema,
  CatalogItemNameSchema,
} from '@ferretry/protocol';
import { z } from 'zod';

const LOCAL_SKILL_INSTALLS_SCHEMA_VERSION = 1 as const;

const LocalSkillInstalledFileSchema = z.strictObject({
  path: z.string().min(1).max(4_096),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
});
export type LocalSkillInstalledFile = z.infer<typeof LocalSkillInstalledFileSchema>;

const LocalSkillInstallRecordSchema = z.strictObject({
  installId: LocalSkillInstallIdSchema,
  installedAt: InstantSchema,
  name: CatalogItemNameSchema,
  /** Where it came from on this machine, as the inventory listed it. */
  origin: LocalSkillOriginSchema,
  /** The synthetic provenance a runtime install hands the fleet. Recorded so a replace matches it. */
  provenance: CatalogProvenanceSchema,
  target: CatalogInstallTargetSchema,
  destination: z.string().min(1),
  /** Where it lands, one value per place: two copies with the same key would overwrite each other. */
  key: z.string().min(1).max(4_200),
  /** Every file written, as a path from the root (project) or from the skill store (runtime). */
  files: z.array(LocalSkillInstalledFileSchema),
  /** A project copy's normalised root and its folder relative to it. */
  root: z.string().min(1).max(4_096).optional(),
  folder: z.string().min(1).max(4_096).optional(),
  /** A runtime copy: the SHA-256 of the stored component, taken when it landed. */
  componentSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/u)
    .optional(),
});
export type LocalSkillInstallRecord = z.infer<typeof LocalSkillInstallRecordSchema>;

export const LocalSkillInstallStateSchema = z.strictObject({
  schemaVersion: z.literal(LOCAL_SKILL_INSTALLS_SCHEMA_VERSION),
  installs: z.array(LocalSkillInstallRecordSchema),
});
export type LocalSkillInstallState = z.infer<typeof LocalSkillInstallStateSchema>;

export const EMPTY_LOCAL_SKILL_INSTALL_STATE: LocalSkillInstallState = {
  schemaVersion: LOCAL_SKILL_INSTALLS_SCHEMA_VERSION,
  installs: [],
};

/** The file could not be read as this daemon writes it. Never answered as "no copies". */
export class LocalSkillInstallStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalSkillInstallStateError';
  }
}

export interface LocalSkillInstallStore {
  /** The state; an empty one when there is no file yet. Throws {@link LocalSkillInstallStateError} on a damaged file. */
  read(): Promise<LocalSkillInstallState>;
  write(state: LocalSkillInstallState): Promise<void>;
}
