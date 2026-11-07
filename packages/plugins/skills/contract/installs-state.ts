/**
 * `state/skills/installs.json`: what this machine remembers about the skills it copied from itself. One record per
 * copy, with the SHA-256 of every file it wrote, so a later remove or update finds a local edit instead of
 * overwriting it. Nothing here is a catalog's: no publisher, no pin, no revision.
 */
import { InstantSchema } from '@ferretry/std';
import { z } from 'zod';
import {
  LocalSkillInstallIdSchema,
  LocalSkillOriginSchema,
  SkillInstallTargetSchema,
  SkillNameSchema,
  SkillProvenanceSchema,
} from './wire.ts';

export const LocalSkillInstalledFileSchema = z.strictObject({
  path: z.string().min(1).max(4_096),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
});
export type LocalSkillInstalledFile = z.infer<typeof LocalSkillInstalledFileSchema>;

export const LocalSkillInstallRecordSchema = z.strictObject({
  installId: LocalSkillInstallIdSchema,
  installedAt: InstantSchema,
  name: SkillNameSchema,
  /** Where it came from on this machine, as the inventory listed it. */
  origin: LocalSkillOriginSchema,
  /** The synthetic provenance a runtime install hands the runtime. Recorded so a replace matches it. */
  provenance: SkillProvenanceSchema,
  target: SkillInstallTargetSchema,
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
  format: z.literal(1),
  installs: z.array(LocalSkillInstallRecordSchema),
});
export type LocalSkillInstallState = z.infer<typeof LocalSkillInstallStateSchema>;
