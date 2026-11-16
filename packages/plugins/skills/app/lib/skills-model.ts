/**
 * What the Skills half says and counts, as pure functions over what the daemon answered (today's `context-rail-model.ts`
 * skills section, the skill half of `mcp-model.ts`, `skills-catalog.ts`'s insertion contract).
 *
 * The rows, chips and sentences only: the daemon owns which skills exist, which one wins a name. Nothing here recomputes any of that.
 */
import { chipsFor, matchesQuery } from '@ferretry/app/ui';
import type { HarnessKey } from '@ferretry/core-ferrets/contract';
import { parseReferenceToken } from '@ferretry/app';
import type { FerretSkillsInventory, SkillEntry, SkillScope } from '../../contract/index.ts';

// ── Scopes ───────────────────────────────────────────────────────────────────────────────────────────────────────

export const SKILL_SCOPE_LABEL: Readonly<Record<SkillScope, string>> = {
  ferretry: 'Ferretry',
  user: 'This account',
  project: 'This project',
};

export const SKILL_SCOPE_TITLE: Readonly<Record<SkillScope, string>> = {
  ferretry: 'A Ferretry skill item in this runtime’s profile',
  user: 'In this account’s own skills folder, so every ferret on this account has it',
  project: 'In this project’s skills folder, so every ferret in this folder has it',
};

/** "Not active: …", for a skill a same-named one of another scope wins over. */
export const skillOverride = (skill: SkillEntry): string | undefined =>
  skill.shadowedBy === undefined
    ? undefined
    : `Not active: the skill of the same name in ${SKILL_SCOPE_LABEL[skill.shadowedBy]} wins`;

const SKILL_SCOPE_ORDER: readonly SkillScope[] = ['project', 'user', 'ferretry'];

/** The winning skills first, Project before User before Ferretry, then by name. */
export const sortedSkills = (skills: readonly SkillEntry[]): SkillEntry[] =>
  [...skills].sort(
    (left, right) =>
      Number(left.shadowedBy !== undefined) - Number(right.shadowedBy !== undefined) ||
      SKILL_SCOPE_ORDER.indexOf(left.scope) - SKILL_SCOPE_ORDER.indexOf(right.scope) ||
      left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }),
  );

// ── The insertion contract ────────────────────────────────────────────────────────────────────────────────────────

/**
 * THE INSERTION CONTRACT, and it is not the same on both harnesses. Claude invokes a skill as `/name`. Codex uses
 * `/skills` to BROWSE and `$name` to actually invoke one, so inserting `/name` there would type a command Codex does not
 * have. What lands in the draft is whatever that harness understands.
 */
export const skillInsertText = (harness: HarnessKey, name: string): string =>
  harness === 'codex' ? `$${name}` : `/${name}`;

/** The one-line reminder of which harness the reader is inserting for. */
export const skillHarnessLabel = (harness: HarnessKey): string =>
  harness === 'codex' ? 'Codex · inserts $name' : 'Claude · inserts /name';

/** Append one invocation as a new draft token while preserving real content. */
export const appendSkillInvocation = (draft: string, invocation: string): string => {
  if (draft.trim().length === 0) return `${invocation} `;
  return `${draft}${/\s$/u.test(draft) ? '' : ' '}${invocation} `;
};

// ── The Skills list of one ferret ─────────────────────────────────────────────────────────────────────────────────

export const SKILLS_SEARCH_LABEL = 'Search skills';
export const NO_SKILLS = 'No skills are installed for this ferret.';

export type SkillChip = 'all' | SkillScope;

const SKILL_CHIPS: readonly SkillChip[] = ['all', 'project', 'user', 'ferretry'];
const SKILL_CHIP_LABEL: Readonly<Record<SkillChip, string>> = { all: 'All', ...SKILL_SCOPE_LABEL };

const skillInChip = (skill: SkillEntry, chip: SkillChip): boolean => chip === 'all' || skill.scope === chip;

const skillMatches = (skill: SkillEntry, query: string): boolean =>
  matchesQuery(query, skill.name, skill.description, SKILL_SCOPE_LABEL[skill.scope]);

/**
 * The chips. A scope is offered only when this ferret has a skill from it: a permanently empty "Project 0" chip on a ferret
 * outside any project is a control that can never do anything.
 */
export const skillChips = (skills: readonly SkillEntry[], query: string) =>
  chipsFor(
    SKILL_CHIPS,
    SKILL_CHIP_LABEL,
    skills.filter(skill => skillMatches(skill, query)),
    skillInChip,
  ).filter(chip => chip.key === 'all' || skills.some(skill => skill.scope === chip.key));

export const visibleSkills = (skills: readonly SkillEntry[], query: string, chip: SkillChip): SkillEntry[] =>
  skills.filter(skill => skillInChip(skill, chip) && skillMatches(skill, query));

/** How many skills this ferret actually loads: the ones no other scope overrides. */
export const loadedSkillCount = (skills: readonly SkillEntry[]): number =>
  skills.filter(skill => skill.shadowedBy === undefined).length;

/** The line above the list: how many this ferret can use, how one is inserted, which account it runs as, and a cut-short list. */
export const activeSkillsLine = (inventory: FerretSkillsInventory): string =>
  [
    `${String(loadedSkillCount(inventory.skills))} active in this ferret`,
    skillHarnessLabel(inventory.harness),
    ...(inventory.runtime === undefined ? [] : [`account ${inventory.runtime}`]),
    ...(inventory.truncated ? ['the list was cut short'] : []),
  ].join(' · ');

/** A SKILL.md's YAML front matter, and the Markdown after it. */
export const splitFrontMatter = (content: string): { readonly frontMatter: string | null; readonly body: string } => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u.exec(content);
  return match === null
    ? { frontMatter: null, body: content }
    : { frontMatter: match[1] ?? '', body: content.slice(match[0].length) };
};

// ── A `/name` or `$name` written anywhere ─────────────────────────────────────────────────────────────────────────

/**
 * The skill name in what a reference renderer was handed: the written token (`/summary`, `$summary`) or an object whose
 * `name` is one. It is read by the shared reference grammar (`parseReferenceToken`, docs/reference-standard.md), never by a
 * rule of this half's own, so `$HOME`, `/Summary` and a bare `summary` are not skills.
 */
export const skillNameOf = (value: unknown): string | undefined => {
  const written =
    typeof value === 'string'
      ? value
      : typeof (value as { name?: unknown } | null)?.name === 'string'
        ? (value as { name: string }).name
        : '';
  const reference = parseReferenceToken(written);
  return reference?.kind === 'skill' ? reference.name : undefined;
};

/** The ferret and daemon a reference was written in, when its value says (a plain token says neither). */
export const referenceScope = (value: unknown): { readonly ferretId?: string; readonly daemon?: string } => {
  const object = typeof value === 'object' && value !== null ? (value as { ferretId?: unknown; daemon?: unknown }) : {};
  return {
    ...(typeof object.ferretId === 'string' && object.ferretId !== '' ? { ferretId: object.ferretId } : {}),
    ...(typeof object.daemon === 'string' && object.daemon !== '' ? { daemon: object.daemon } : {}),
  };
};
