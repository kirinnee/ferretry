/**
 * The skills on ONE machine, path included: what My catalogs' Publish skills picker lists. The inventory (`GET /v1/skills`)
 * is Skills' own route, read through the client the shell built this half with and parsed with Skills' contract; the
 * loader stays a seam so a test or harness can fill it, and the default (no loader at all) says why nothing is listed.
 */
import { MachineSkillsInventorySchema } from '@ferretry/plugin-skills/contract';
import type { PluginClient } from '@ferretry/kernel/manifest';

type Harness = 'claude' | 'codex' | 'generic';

/** One skill as Skills' inventory lists it (the fields the picker reads). */
export interface SkillEntry {
  readonly name: string;
  readonly description: string;
  readonly harness: Harness;
  readonly scope: string;
  /** Absolute path of the SKILL.md: what publishing takes. */
  readonly path: string;
  readonly runtimes: readonly string[];
  readonly project?: { readonly name: string; readonly root: string } | undefined;
  /** Set when a same-name skill of this scope wins over this one. */
  readonly shadowedBy?: string | undefined;
}

/** Reads this machine's skills, path included. A seam for the host, tests and the harness. */
export type MachineSkillEntriesLoader = (signal: AbortSignal) => Promise<readonly SkillEntry[]>;

/** The default loader: Catalogs has no route to the skills inventory, so it says so rather than listing nothing. */
export const noMachineSkills: MachineSkillEntriesLoader = () =>
  Promise.reject(new Error('Skills has not offered its list to Catalogs yet.'));

/**
 * Every skill on this machine as Skills' inventory lists it: the account homes first, then the projects (each skill
 * naming its project). A skill another one of the same name hides (`shadowedBy`) is still listed, because a person may
 * publish it on purpose.
 */
export const fetchMachineSkillEntries = async (
  client: Pick<PluginClient, 'call'>,
  signal?: AbortSignal,
): Promise<readonly SkillEntry[]> => {
  const inventory = MachineSkillsInventorySchema.parse(
    await client.call('GET /v1/skills', signal === undefined ? {} : { signal }),
  );
  const entry = (
    skill: (typeof inventory.homes)[number]['skills'][number],
    project?: SkillEntry['project'],
  ): SkillEntry => ({
    name: skill.name,
    description: skill.description,
    harness: skill.harness === 'claude-code' ? 'claude' : skill.harness,
    scope: skill.scope,
    path: skill.path,
    runtimes: skill.runtimes,
    ...(project === undefined ? {} : { project }),
    ...(skill.shadowedBy === undefined ? {} : { shadowedBy: skill.shadowedBy }),
  });
  return [
    ...inventory.homes.flatMap(home => home.skills.map(skill => entry(skill))),
    ...inventory.projects.flatMap(project =>
      project.skills.map(skill => entry(skill, { name: project.name, root: project.root })),
    ),
  ];
};
