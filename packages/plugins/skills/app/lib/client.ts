/**
 * Skills' wire, through the one generated client this half is given (§9.6): every call is `client.call(routeKey, init)`
 * and every answer is parsed with the contract's own schema, so a body this half cannot read fails at the call rather than
 * as a blank row. No code here holds a base URL, a token or a fetch.
 *
 * The copy routes are a person's act and ask for a fresh passkey through the carrier on their own (`403
 * grant_step_up_required`); nothing here handles one — the refusal reaches `localRefusal` as it is.
 */
import type { PluginClient } from '@ferretry/kernel/manifest';
import {
  type FerretSkillsInventory,
  FerretSkillsInventorySchema,
  type FerretSkills,
  FerretSkillsSchema,
  type LocalSkillInstalled,
  LocalSkillInstalledSchema,
  type LocalSkillInstallId,
  type LocalSkillInstallList,
  LocalSkillInstallListSchema,
  type LocalSkillInstallRequest,
  LocalSkillInstallRequestSchema,
  type LocalSkillPreview,
  type LocalSkillPreviewRequest,
  LocalSkillPreviewRequestSchema,
  LocalSkillPreviewSchema,
  type LocalSkillRemoved,
  LocalSkillRemovedSchema,
  type MachineSkillsInventory,
  MachineSkillsInventorySchema,
  type SkillFile,
  SkillFileSchema,
  type SkillInstallScope,
} from '../../contract/index.ts';

/** The slice of the per-daemon client this half uses; a test hands a scripted one. */
export type SkillsClient = Pick<PluginClient, 'call'>;

const FERRET_INVENTORY_ROUTE = 'GET /v1/ferrets/:ferretId/skills/inventory' as const;
const FERRET_SKILLS_ROUTE = 'GET /v1/ferrets/:ferretId/skills' as const;
const MACHINE_INVENTORY_ROUTE = 'GET /v1/skills' as const;
const SKILL_FILE_ROUTE = 'GET /v1/skills/file' as const;
const INSTALLS_ROUTE = 'GET /v1/skill-installs/local' as const;

const PREVIEW_ROUTES = {
  project: 'POST /v1/skill-installs/local/project/preview',
  runtime: 'POST /v1/skill-installs/local/runtime/preview',
} as const;
const INSTALL_ROUTES = {
  project: 'POST /v1/skill-installs/local/project',
  runtime: 'POST /v1/skill-installs/local/runtime',
} as const;
const REMOVE_ROUTES = {
  project: 'DELETE /v1/skill-installs/local/project/:installId',
  runtime: 'DELETE /v1/skill-installs/local/runtime/:installId',
} as const;

/** Every skill one ferret sees, with its scope and SKILL.md path, on that ferret's machine. */
export const readFerretSkillsInventory = async (
  client: SkillsClient,
  ferretId: string,
): Promise<FerretSkillsInventory> =>
  FerretSkillsInventorySchema.parse(await client.call(FERRET_INVENTORY_ROUTE, { params: { ferretId } }));

/** The names a ferret can invoke (`/name`, `$name`): what a skill reference is proved against. */
export const readFerretSkills = async (client: SkillsClient, ferretId: string): Promise<FerretSkills> =>
  FerretSkillsSchema.parse(await client.call(FERRET_SKILLS_ROUTE, { params: { ferretId } }));

/** Every runtime home's and registered project's skills, path included. */
export const readMachineSkills = async (client: SkillsClient): Promise<MachineSkillsInventory> =>
  MachineSkillsInventorySchema.parse(await client.call(MACHINE_INVENTORY_ROUTE));

/** One listed skill's SKILL.md. The daemon serves only a path its own inventory lists. */
export const readSkillFile = async (client: SkillsClient, path: string, ferretId?: string): Promise<SkillFile> =>
  SkillFileSchema.parse(
    await client.call(SKILL_FILE_ROUTE, { query: { path, ...(ferretId === undefined ? {} : { ferretId }) } }),
  );

/** The skills this machine copied from itself. */
export const listSkillInstalls = async (client: SkillsClient): Promise<LocalSkillInstallList> =>
  LocalSkillInstallListSchema.parse(await client.call(INSTALLS_ROUTE));

/** Reads the skill and answers the review. Writes nothing. */
export const previewSkillInstall = async (
  client: SkillsClient,
  scope: SkillInstallScope,
  request: LocalSkillPreviewRequest,
): Promise<LocalSkillPreview> =>
  LocalSkillPreviewSchema.parse(
    await client.call(PREVIEW_ROUTES[scope], { body: LocalSkillPreviewRequestSchema.parse(request) }),
  );

/** Copies exactly one preview. */
export const applySkillInstall = async (
  client: SkillsClient,
  scope: SkillInstallScope,
  request: LocalSkillInstallRequest,
): Promise<LocalSkillInstalled> =>
  LocalSkillInstalledSchema.parse(
    await client.call(INSTALL_ROUTES[scope], { body: LocalSkillInstallRequestSchema.parse(request) }),
  );

/** Takes out exactly the files one copy wrote. */
export const removeSkillInstall = async (
  client: SkillsClient,
  scope: SkillInstallScope,
  installId: LocalSkillInstallId,
): Promise<LocalSkillRemoved> =>
  LocalSkillRemovedSchema.parse(await client.call(REMOVE_ROUTES[scope], { params: { installId } }));
