/**
 * The browser's half of the routes that copy a skill from elsewhere on this machine
 * (docs/catalogs.md, "Copying a skill from this machine"). Each scope has its own routes because a project
 * write and a runtime write are governed by different capabilities.
 *
 * The apply asks for a fresh passkey through the carrier on its own (`403 grant_step_up_required`).
 * Nothing here handles one.
 */

import {
  LOCAL_SKILL_INSTALLS_PATH,
  type CatalogInstallScope,
  type LocalSkillInstalled,
  LocalSkillInstalledSchema,
  type LocalSkillInstallList,
  LocalSkillInstallListSchema,
  type LocalSkillInstallRequest,
  LocalSkillInstallRequestSchema,
  type LocalSkillPreview,
  type LocalSkillPreviewRequest,
  LocalSkillPreviewRequestSchema,
  LocalSkillPreviewSchema,
  localSkillInstallsPath,
} from '@ferretry/protocol';
import type { CatalogClient } from './catalogs-api.ts';

const jsonBody = (body: unknown): RequestInit => ({
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/** Reads the skill and answers the review. Writes nothing. */
export async function previewLocalSkillInstall(
  client: CatalogClient,
  scope: CatalogInstallScope,
  request: LocalSkillPreviewRequest,
): Promise<LocalSkillPreview> {
  return await client.request(localSkillInstallsPath(scope, true), LocalSkillPreviewSchema, {
    method: 'POST',
    ...jsonBody(LocalSkillPreviewRequestSchema.parse(request)),
  });
}

/** Copies exactly one preview. */
export async function applyLocalSkillInstall(
  client: CatalogClient,
  scope: CatalogInstallScope,
  request: LocalSkillInstallRequest,
): Promise<LocalSkillInstalled> {
  return await client.request(localSkillInstallsPath(scope), LocalSkillInstalledSchema, {
    method: 'POST',
    ...jsonBody(LocalSkillInstallRequestSchema.parse(request)),
  });
}

/** The skills this machine copied from itself. */
export async function listLocalSkillInstalls(client: CatalogClient): Promise<LocalSkillInstallList> {
  return await client.request(LOCAL_SKILL_INSTALLS_PATH, LocalSkillInstallListSchema);
}
