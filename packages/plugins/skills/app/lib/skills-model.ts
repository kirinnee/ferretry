/**
 * What the Skills half says and counts, as pure functions over what the daemon answered (today's `context-rail-model.ts`
 * skills section, the skill half of `mcp-model.ts`, `skills-catalog.ts`'s insertion contract and `machine-skills-model.ts`).
 *
 * The rows, chips and sentences only: the daemon owns which skills exist, which one wins a name and what a copy may
 * hold. Nothing here recomputes any of that.
 */
import { chipsFor, matchesQuery } from '@ferretry/app/ui';
import type { HarnessKey } from '@ferretry/core-ferrets/contract';
import { DaemonCallError } from '@ferretry/app';
import type {
  FerretSkillsInventory,
  LocalSkillInstall,
  LocalSkillOrigin,
  LocalSkillPreview,
  LocalSkillPreviewRequest,
  MachineSkillsInventory,
  SkillEntry,
  SkillInstallTarget,
  SkillScope,
} from '../../contract/index.ts';

export type { ContextChip } from '@ferretry/app/ui';

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

// ── Adding a skill from this machine ──────────────────────────────────────────────────────────────────────────────

export const ADD_SKILLS_BUTTON = '+ Add skills';
export const ADD_SKILLS_TITLE = 'Add skills';
export const ADD_SKILLS_BACK = 'Back to the skills';
export const INSTALL_BUTTON = 'Install';
export const INSTALLED_LABEL = 'Installed';
export const ON_THIS_MACHINE = 'On this machine';
export const MACHINE_NOTE = 'Skills on other accounts and projects here that this ferret does not have.';
export const READING_MACHINE = 'Reading this machine’s skills…';
export const MACHINE_UNREADABLE = 'This machine’s skills could not be read. Press Refresh to try again.';
export const NO_MACHINE_SKILLS = 'No other account or project on this machine has a skill this ferret lacks.';
export const NO_MACHINE_MATCH = 'No skill on this machine matches that.';
export const MACHINE_TRUNCATED = 'This machine has more skills than the list holds, so some are not shown.';
export const REFRESH_BUTTON = 'Refresh';
export const REVIEW_BEFORE_INSTALLING = 'Review before installing';
export const CHECK_AGAIN = 'Check again';
export const COPY_NOTE = 'It is copied, not linked: the original stays where it is, and the two stay separate.';
export const NOT_COPIED_HEADING = 'Not copied';
export const REPLACES_NOTE = 'It replaces the copy you made from this machine before.';
export const EXPIRY_NOTE = 'This preview lasts 10 minutes. After that, preview it again.';
export const INSTALL_WITH_PASSKEY = 'Install · confirm with passkey';
export const REMOVE_NOTE = 'This takes out what the install wrote. Your other files are not touched.';

const harnessName = (harness: HarnessKey): string => (harness === 'codex' ? 'Codex' : 'Claude');

/** One skill from elsewhere on this machine, ready to list. */
export interface MachineSkillRow {
  /** The SKILL.md path the inventory listed: the only thing the copy route is told to read. */
  readonly path: string;
  readonly name: string;
  readonly description: string;
  readonly harness: HarnessKey;
  /** "claude-default account" or "project dojo". */
  readonly from: string;
  /** A copy of this skill was already made from here, so the row says Installed. */
  readonly installed: boolean;
}

const rowOf = (entry: SkillEntry, from: string, copied: ReadonlySet<string>): MachineSkillRow => ({
  path: entry.path,
  name: entry.name,
  description: entry.description,
  harness: entry.harness,
  from,
  installed: copied.has(entry.path),
});

/**
 * Every skill on the machine this ferret does not see, once each. A skill is "in this ferret" when the ferret lists its
 * path, or any skill of the same name (a copy would collide with it, and the harness would load only one).
 */
export function machineRows(
  machine: MachineSkillsInventory,
  ferret: Pick<FerretSkillsInventory, 'skills'>,
  copiedPaths: ReadonlySet<string>,
): readonly MachineSkillRow[] {
  const seenPaths = new Set(ferret.skills.map(skill => skill.path));
  const seenNames = new Set(ferret.skills.map(skill => skill.name.toLowerCase()));
  const rows: MachineSkillRow[] = [];
  const add = (entry: SkillEntry, from: string): void => {
    if (seenPaths.has(entry.path) || seenNames.has(entry.name.toLowerCase())) return;
    seenPaths.add(entry.path);
    rows.push(rowOf(entry, from, copiedPaths));
  };
  for (const home of machine.homes) for (const entry of home.skills) add(entry, `${home.runtime} account`);
  for (const project of machine.projects) for (const entry of project.skills) add(entry, `project ${project.name}`);
  return rows;
}

/** The rows whose name, description or place hold every word typed. */
export function filterMachineRows(rows: readonly MachineSkillRow[], query: string): readonly MachineSkillRow[] {
  const words = query
    .toLowerCase()
    .split(/\s+/u)
    .filter(word => word !== '');
  if (words.length === 0) return rows;
  return rows.filter(row => {
    const text = `${row.name} ${row.description} ${row.from}`.toLowerCase();
    return words.every(word => text.includes(word));
  });
}

/** The line under a row's name: where it lives and for which agent. */
export const rowFromLine = (row: Pick<MachineSkillRow, 'from' | 'harness'>): string =>
  `${row.from} · ${harnessName(row.harness)}`;

/** The places Install offers: the projects the machine registered. */
export interface TargetOptions {
  readonly projects: readonly { readonly root: string; readonly label: string }[];
}

export const targetOptions = (machine: MachineSkillsInventory): TargetOptions => ({
  projects: machine.projects.map(project => ({ root: project.root, label: project.name })),
});

/** What the person has chosen so far. Every field may still be missing. */
export interface TargetDraft {
  readonly projectRoot?: string;
  readonly harness?: HarnessKey;
}

export const NO_PLACE_YET = 'Pick a project.';
export const NO_AGENT_YET = 'Pick Claude or Codex for this project.';

export function targetProblem(draft: TargetDraft, options: TargetOptions): string | null {
  if (!options.projects.some(project => project.root === draft.projectRoot)) return NO_PLACE_YET;
  return draft.harness === undefined ? NO_AGENT_YET : null;
}

/** The wire target for a draft that passed {@link targetProblem}, else `null`. */
export const toTarget = (draft: TargetDraft): SkillInstallTarget | null =>
  draft.projectRoot === undefined || draft.harness === undefined
    ? null
    : { scope: 'project', projectRoot: draft.projectRoot, harness: draft.harness };

/** The preview request for one row and a chosen place. */
export const previewRequest = (
  row: Pick<MachineSkillRow, 'path'>,
  target: SkillInstallTarget,
): LocalSkillPreviewRequest => ({ source: { path: row.path }, target });

/** Where the preview says the skill is from: the account or project, the agent, and the SKILL.md path. */
export const originLine = (origin: LocalSkillOrigin): string =>
  `${origin.kind === 'project' ? 'Project' : 'Account'} ${origin.owner} · ${harnessName(origin.harness)} · ${origin.path}`;

/** One line for each file the copy leaves behind, with the reason the machine gave. */
export const skippedLines = (preview: Pick<LocalSkillPreview, 'skipped'>): readonly string[] =>
  preview.skipped.map(problem => `${problem.subject}: ${problem.reason}`);

/** What a copy that landed says about itself: its name. */
export const copiedLine = (install: Pick<LocalSkillInstall, 'name'>): string => `${install.name} · copied`;

/** An installed copy's row in Settings: its name and where it was put. */
export const installLine = (install: Pick<LocalSkillInstall, 'name' | 'destination'>): string =>
  `${install.name} · ${install.destination}`;

// ── Refusals ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface LocalRefusal {
  readonly sentence: string;
  /** The preview is gone or ran out: offer "Preview again". */
  readonly previewAgain: boolean;
}

const STEP_UP =
  'Nothing was installed: the passkey wasn’t confirmed. Press Install and confirm again. Each install needs its own passkey.';

/** The machine's sentence for any other refusal, or a plain line when it gave none. */
export const refusalSentence = (error: unknown): string => {
  if (error instanceof DaemonCallError)
    return error.message.trim() === '' ? `This machine refused the change (${String(error.status)}).` : error.message;
  return error instanceof Error && error.message.trim() !== '' ? error.message : 'This machine didn’t answer.';
};

const withReason = (general: string, error: DaemonCallError): string => {
  const reason = error.message.trim();
  return reason === '' ? general : `${general} ${reason}`;
};

/**
 * What a refused preview or apply says. The machine's sentence for a source it will not copy is shown as it wrote it: it
 * names the file and line (never the text) or the cap that was hit.
 */
export function localRefusal(error: unknown): LocalRefusal {
  const code = error instanceof DaemonCallError ? error.code : undefined;
  const sentence = ((): string => {
    if (!(error instanceof DaemonCallError)) return refusalSentence(error);
    switch (code) {
      case 'grant_step_up_required':
        return STEP_UP;
      case 'local_skill_source_invalid':
        return error.message.trim() === '' ? 'This skill cannot be copied. Nothing was installed.' : error.message;
      case 'local_skill_source_unknown':
        return withReason('This machine no longer lists that skill. Nothing was installed.', error);
      case 'local_skill_target_unknown':
        return withReason('This machine does not know that project or profile. Pick another place.', error);
      case 'local_skill_conflict':
        return withReason('Something is already where this would go. Nothing was changed.', error);
      case 'local_skill_preview_unknown':
        return 'That preview is gone. Nothing was installed. Preview it again.';
      case 'local_skill_preview_expired':
        return 'That preview ran out after 10 minutes. Nothing was installed. Preview it again.';
      case 'local_skill_install_unknown':
        return 'This machine has no such copy any more.';
      default:
        return refusalSentence(error);
    }
  })();
  return {
    sentence,
    previewAgain: code === 'local_skill_preview_unknown' || code === 'local_skill_preview_expired',
  };
}

// ── A `/name` or `$name` written anywhere ─────────────────────────────────────────────────────────────────────────

const SKILL_NAME = /^[a-z][a-z0-9-]{0,63}$/u;

/**
 * The skill name in what a reference renderer was handed: the written token (`/summary`, `$summary`, `summary`) or an
 * object with a `name`. `undefined` when it is not a skill name — the grammar's own rule, lowercase only, so `$HOME` is
 * never read as a skill.
 */
export const skillNameOf = (value: unknown): string | undefined => {
  const written =
    typeof value === 'string'
      ? value
      : typeof (value as { name?: unknown } | null)?.name === 'string'
        ? (value as { name: string }).name
        : '';
  const name = written.replace(/^[/$]/u, '');
  return SKILL_NAME.test(name) ? name : undefined;
};

/** The ferret and daemon a reference was written in, when its value says (a plain token says neither). */
export const referenceScope = (value: unknown): { readonly ferretId?: string; readonly daemon?: string } => {
  const object = typeof value === 'object' && value !== null ? (value as { ferretId?: unknown; daemon?: unknown }) : {};
  return {
    ...(typeof object.ferretId === 'string' && object.ferretId !== '' ? { ferretId: object.ferretId } : {}),
    ...(typeof object.daemon === 'string' && object.daemon !== '' ? { daemon: object.daemon } : {}),
  };
};
