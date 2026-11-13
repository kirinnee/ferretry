/**
 * Skills' wire, through the one generated client this half is given (§9.6): every call is `client.call(routeKey, init)`
 * and every answer is parsed with the contract's own schema, so a body this half cannot read fails at the call rather than
 * as a blank row. No code here holds a base URL, a token or a fetch.
 */
import type { PluginClient } from '@ferretry/kernel/manifest';
import {
  type FerretSkillsInventory,
  FerretSkillsInventorySchema,
  type FerretSkills,
  FerretSkillsSchema,
  type MachineSkillsInventory,
  MachineSkillsInventorySchema,
  type SkillFile,
  SkillFileSchema,
} from '../../contract/index.ts';

/** The slice of the per-daemon client this half uses; a test hands a scripted one. */
export type SkillsClient = Pick<PluginClient, 'call'>;

const FERRET_INVENTORY_ROUTE = 'GET /v1/ferrets/:ferretId/skills/inventory' as const;
const FERRET_SKILLS_ROUTE = 'GET /v1/ferrets/:ferretId/skills' as const;
const MACHINE_INVENTORY_ROUTE = 'GET /v1/skills' as const;
const SKILL_FILE_ROUTE = 'GET /v1/skills/file' as const;

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
