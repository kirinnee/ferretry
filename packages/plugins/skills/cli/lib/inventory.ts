/**
 * `fy skill ls`: the skills a ferret sees (inside one, or `--session <id>`), or every runtime home and registered project
 * on this machine (`--machine`, or outside a ferret). Names, where each comes from and what it is for: never a file's text.
 */
import type { PluginClient } from '@ferretry/kernel/manifest';
import {
  type FerretSkillsInventory,
  FerretSkillsInventorySchema,
  type MachineSkillsInventory,
  MachineSkillsInventorySchema,
  type SkillEntry,
} from '../../contract/index.ts';

const SCOPE_WORD: Readonly<Record<SkillEntry['scope'], string>> = {
  ferretry: 'Ferretry',
  user: 'User',
  project: 'Project',
};

/** One skill: its name, where it comes from, what hides it, and what it is for. */
function line(skill: SkillEntry): string {
  const facts = [
    SCOPE_WORD[skill.scope],
    ...(skill.shadowedBy === undefined ? [] : [`hidden by the ${SCOPE_WORD[skill.shadowedBy]} one`]),
    ...(skill.toggle !== undefined && !skill.toggle.enabled ? ['off'] : []),
  ];
  return `  ${skill.name} · ${facts.join(' · ')} — ${skill.description}`;
}

function renderFerretSkills(view: FerretSkillsInventory): string {
  const heading = `Skills ${view.ferretId} sees (${view.harness}${view.runtime === undefined ? '' : `, runtime ${view.runtime}`}) in ${view.folder}`;
  return [
    heading,
    ...(view.skills.length === 0 ? ['  none'] : view.skills.map(line)),
    ...(view.truncated ? ['  (the list is cut short)'] : []),
  ].join('\n');
}

function renderMachineSkills(view: MachineSkillsInventory): string {
  const lines: string[] = [];
  for (const home of view.homes) {
    lines.push(`Runtime ${home.runtime} (${home.harness})`);
    lines.push(...(home.skills.length === 0 ? ['  none'] : home.skills.map(line)));
  }
  for (const project of view.projects) {
    lines.push(`Project ${project.name} (${project.root})`);
    lines.push(...(project.skills.length === 0 ? ['  none'] : project.skills.map(line)));
  }
  if (lines.length === 0) lines.push('No skills on this machine yet.');
  if (view.truncated) lines.push('(the list is cut short)');
  return lines.join('\n');
}

export interface SkillLsOptions {
  /** The ferret to read, or none for the machine. */
  readonly ferret?: string;
  readonly json: boolean;
}

/** Reads the list and says it. */
export async function skillLs(
  client: Pick<PluginClient, 'call'>,
  out: (text: string) => void,
  options: SkillLsOptions,
): Promise<number> {
  if (options.ferret !== undefined) {
    const view = FerretSkillsInventorySchema.parse(
      await client.call('GET /v1/ferrets/:ferretId/skills/inventory', { params: { ferretId: options.ferret } }),
    );
    out(`${options.json ? JSON.stringify(view, null, 2) : renderFerretSkills(view)}\n`);
    return 0;
  }
  const view = MachineSkillsInventorySchema.parse(await client.call('GET /v1/skills'));
  out(`${options.json ? JSON.stringify(view, null, 2) : renderMachineSkills(view)}\n`);
  return 0;
}
