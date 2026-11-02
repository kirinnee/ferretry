/**
 * "On this machine": the skills that live on other accounts and projects here, and what Install says about
 * one of them, as pure functions (docs/catalogs.md "Copying a skill from this machine").
 *
 * The list is the machine's skills inventory minus what this session already sees. Install is the copy
 * route's preview → review → passkey → apply; nothing here decides anything the daemon also decides.
 */

import {
  type LocalSkillInstall,
  type LocalSkillOrigin,
  type LocalSkillPreview,
  type LocalSkillPreviewRequest,
  type MachineSkillsInventory,
  revealHidden,
  type SessionSkillsInventory,
  type SkillEntry,
} from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import type { FleetProject } from '../../lib/fleet-grouping.ts';
import { changeRefusalSentence } from '../fleet/shell/apply-change.ts';
import type { TargetOptions, TargetPick } from '../catalogs/catalog-install-model.ts';
import type { RuntimeChoice } from './add-skills-model.ts';

export const ON_THIS_MACHINE = 'On this machine';
export const MACHINE_NOTE = 'Skills on other accounts and projects here that this session does not have.';
export const READING_MACHINE = 'Reading this machine’s skills…';
export const MACHINE_UNREADABLE = 'This machine’s skills could not be read. Close this and open it again to retry.';
export const NO_MACHINE_SKILLS = 'No other account or project on this machine has a skill this session lacks.';
export const NO_MACHINE_MATCH = 'No skill on this machine matches that.';
export const MACHINE_TRUNCATED = 'This machine has more skills than the list holds, so some are not shown.';
export const REVIEW_BEFORE_INSTALLING = 'Review before installing';
export const COPY_NOTE = 'It is copied, not linked: the original stays where it is, and the two stay separate.';
export const NOT_COPIED_HEADING = 'Not copied';

const harnessName = (harness: 'claude' | 'codex'): string => (harness === 'claude' ? 'Claude' : 'Codex');

/** One skill from elsewhere on this machine, ready to list. */
export interface MachineSkillRow {
  /** The SKILL.md path the inventory listed: the only thing the copy route is told to read. */
  readonly path: string;
  readonly name: string;
  readonly description: string;
  readonly harness: 'claude' | 'codex';
  /** "claude-default account" or "project dojo". */
  readonly from: string;
  /** A copy of this skill was already made from here, so the row says Installed. */
  readonly installed: boolean;
}

const rowOf = (entry: SkillEntry, from: string, copied: ReadonlySet<string>): MachineSkillRow => ({
  path: entry.path,
  name: revealHidden(entry.name),
  description: revealHidden(entry.description),
  harness: entry.harness,
  from: revealHidden(from),
  installed: copied.has(entry.path),
});

/**
 * Every skill on the machine this session does not see, once each. A skill is "in this session" when the
 * session lists its path, or any skill of the same name (a copy would collide with it, and the harness
 * would load only one).
 */
export function machineRows(
  machine: MachineSkillsInventory,
  session: SessionSkillsInventory,
  copiedPaths: ReadonlySet<string>,
): readonly MachineSkillRow[] {
  const seenPaths = new Set(session.skills.map(skill => skill.path));
  const seenNames = new Set(session.skills.map(skill => skill.name.toLowerCase()));
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

/** The places Install can offer: the projects this browser knows and the runtimes the machine lists. */
export const targetOptions = (
  projects: readonly FleetProject[],
  runtimes: readonly RuntimeChoice[],
): TargetOptions => ({
  projects: projects.map(project => ({ root: project.path, label: project.name })),
  runtimes: runtimes.map(runtime => ({ runtime: runtime.id, profiles: [runtime.profile] })),
});

/** The preview request for one row and a chosen place. */
export const previewRequest = (row: Pick<MachineSkillRow, 'path'>, target: TargetPick): LocalSkillPreviewRequest => ({
  source: { path: row.path },
  target,
});

/** Where the preview says the skill is from: the account or project, the agent, and the SKILL.md path. */
export const originLine = (origin: LocalSkillOrigin): string =>
  `${origin.kind === 'project' ? 'Project' : 'Account'} ${revealHidden(origin.owner)} · ${harnessName(origin.harness)} · ${revealHidden(origin.path)}`;

/** One line for each file the copy leaves behind, with the reason the machine gave. */
export const skippedLines = (preview: Pick<LocalSkillPreview, 'skipped'>): readonly string[] =>
  preview.skipped.map(problem => `${problem.subject}: ${problem.reason}`);

export const REPLACES_NOTE = 'It replaces the copy you made from this machine before.';

// ── Refusals ─────────────────────────────────────────────────────────────────────────────────────

export interface LocalRefusal {
  readonly sentence: string;
  /** The preview is gone or ran out: offer "Preview again". */
  readonly previewAgain: boolean;
}

const STEP_UP =
  'Nothing was installed: the passkey wasn’t confirmed. Press Install and confirm again. Each install needs its own passkey.';

/** The reason in the machine's own words, after the general sentence. */
const withReason = (general: string, error: FyHttpError): string => {
  const reason = error.message.trim();
  return reason === '' ? general : `${general} ${reason}`;
};

/**
 * What a refused preview or apply says. The machine's sentence for a source it will not copy is shown
 * as it wrote it: it names the file and line (never the text) or the cap that was hit.
 */
export function localRefusal(error: unknown): LocalRefusal {
  const code = error instanceof FyHttpError ? error.code : undefined;
  const sentence = ((): string => {
    if (!(error instanceof FyHttpError)) return changeRefusalSentence(error);
    switch (code) {
      case 'grant_step_up_required':
        return STEP_UP;
      case 'local_skill_source_invalid':
        return error.message.trim() === '' ? 'This skill cannot be copied. Nothing was installed.' : error.message;
      case 'local_skill_source_unknown':
        return withReason('This machine no longer lists that skill. Nothing was installed.', error);
      case 'local_skill_target_unknown':
        return withReason('This machine does not know that project, runtime or profile. Pick another place.', error);
      case 'local_skill_conflict':
        return withReason('Something is already where this would go. Nothing was changed.', error);
      case 'local_skill_preview_unknown':
        return 'That preview is gone. Nothing was installed. Preview it again.';
      case 'local_skill_preview_expired':
        return 'That preview ran out after 10 minutes. Nothing was installed. Preview it again.';
      default:
        return changeRefusalSentence(error);
    }
  })();
  return {
    sentence,
    previewAgain: code === 'local_skill_preview_unknown' || code === 'local_skill_preview_expired',
  };
}

/** What a copy that landed says about itself: its name and where it was put. */
export const copiedLine = (install: Pick<LocalSkillInstall, 'name'>): string =>
  `${revealHidden(install.name)} · copied`;
