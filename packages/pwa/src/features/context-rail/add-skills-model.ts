/**
 * "+ Add skills": what the sheet says and decides, as pure functions.
 *
 * The sheet installs through the existing review and hand-off, so the only decisions made here are the
 * default place (this project when the session has a folder, else this account), which skills to list,
 * and the sentence that says where an install landed and whether the running session already sees it.
 */

import {
  type CatalogInstall,
  type SessionSkillsInventory,
  type SharedCatalogManifestEntry,
  revealHidden,
} from '@ferretry/protocol';
import { type FleetProject, normalizeProjectPath } from '../../lib/fleet-grouping.ts';
import type { TargetDraft } from '../catalogs/catalog-install-model.ts';
import type { SharedCatalogView } from '../shared/shared-controller.ts';
import type { CardState } from '../shared/shared-screens-model.ts';

export const ADD_SKILLS_BUTTON = '+ Add skills';
export const ADD_SKILLS_TITLE = 'Add skills to this session';
export const ADD_SKILLS_CLOSE = 'Close Add skills';
export const ADD_SKILLS_SEARCH_LABEL = 'Search skills';
export const FROM_SUBSCRIPTIONS = 'From your subscriptions';
export const SUBSCRIBE_WITH_LINK = 'Subscribe with a link…';
export const INSTALL_BUTTON = 'Install';
export const INSTALLED_LABEL = 'Installed';
export const NO_SUBSCRIPTIONS = 'You do not subscribe to any catalog yet. Subscribe with a link to find skills.';
export const NO_SKILLS_FOUND = 'No subscribed skill matches that.';
export const READING_SUBSCRIPTIONS = 'Reading your subscriptions…';
export const PICK_A_PLACE = 'You will pick where to install it.';

/** What the sheet knows of the session it was opened from. */
export interface SessionPlace {
  /** The session's working folder. */
  readonly cwd: string | undefined;
  readonly harness: 'claude' | 'codex';
  /** The runtime's wrapper name, as the skills inventory names it. */
  readonly runtime: string | undefined;
}

/** A runtime as the install target needs it: its id and profile, and the wrapper the inventory knows it by. */
export interface RuntimeChoice {
  readonly id: string;
  readonly wrapper: string;
  readonly profile: string;
}

/** Where an install goes unless the person picks another place. */
export interface InstallPlan {
  readonly draft: TargetDraft;
  readonly scope: 'project' | 'runtime' | 'none';
  /** The place, in the words the install sheet and the scope line use. */
  readonly sentence: string;
  readonly projectRoot?: string;
  readonly runtimeId?: string;
}

export const PROJECT_SENTENCE = 'This project (every session in this folder)';
export const accountSentence = (runtime: string): string => `This account (every session on ${runtime})`;

/** The registered project that holds `cwd`, the longest path winning, so a nested folder finds its own. */
export function projectHolding(cwd: string, projects: readonly FleetProject[]): FleetProject | undefined {
  const target = normalizeProjectPath(cwd);
  let best: FleetProject | undefined;
  let bestLength = -1;
  for (const project of projects) {
    const path = normalizeProjectPath(project.path);
    if ((target === path || target.startsWith(`${path}/`)) && path.length > bestLength) {
      best = project;
      bestLength = path.length;
    }
  }
  return best;
}

/** This project when the session sits in one, else this account; neither when neither can be told. */
export function installPlan(
  place: SessionPlace,
  projects: readonly FleetProject[],
  runtimes: readonly RuntimeChoice[],
): InstallPlan {
  const project = place.cwd === undefined || place.cwd === '' ? undefined : projectHolding(place.cwd, projects);
  if (project !== undefined)
    return {
      draft: { scope: 'project', projectRoot: project.path, harness: place.harness },
      scope: 'project',
      sentence: PROJECT_SENTENCE,
      projectRoot: project.path,
    };
  const runtime =
    place.runtime === undefined ? undefined : runtimes.find(candidate => candidate.wrapper === place.runtime);
  if (runtime !== undefined)
    return {
      draft: { scope: 'runtime', runtime: runtime.id, profile: runtime.profile },
      scope: 'runtime',
      sentence: accountSentence(runtime.wrapper),
      runtimeId: runtime.id,
    };
  return { draft: {}, scope: 'none', sentence: PICK_A_PLACE };
}

/** The line above the list: where Install will put a skill unless the person picks another place. */
export const scopeLine = (plan: InstallPlan): string =>
  plan.scope === 'none' ? PICK_A_PLACE : `Installs into ${plan.sentence}. You can pick another place when you install.`;

/** One subscribed skill, ready to list. */
export interface SkillRow {
  readonly key: string;
  readonly entry: SharedCatalogManifestEntry;
  readonly view: SharedCatalogView;
  readonly name: string;
  readonly summary: string;
  /** "publisher · catalog". */
  readonly from: string;
  readonly version: string;
  readonly installed: boolean;
}

/** Every skill a publisher's verified catalogs list. A catalog that did not verify lists nothing. */
export function skillRows(
  state: Extract<CardState, { kind: 'ok' }>,
  publisherId: string,
  publisherLabel: string,
  installed: ReadonlyMap<string, string>,
): readonly SkillRow[] {
  return state.blocks.flatMap(block =>
    block.kind === 'problem'
      ? []
      : block.items
          .filter(item => item.entry.kind === 'skill')
          .map(item => ({
            key: `${publisherId}/${block.catalogId}/${item.entry.itemId}`,
            entry: item.entry,
            view: block.view,
            name: revealHidden(item.entry.name),
            summary: item.summary,
            from: `${publisherLabel} · ${block.name}`,
            version: `v${item.entry.version}`,
            installed: installed.has(item.entry.itemId),
          })),
  );
}

/** The rows whose name, summary, publisher or catalog hold every word typed. */
export function filterRows(rows: readonly SkillRow[], query: string): readonly SkillRow[] {
  const words = query
    .toLowerCase()
    .split(/\s+/u)
    .filter(word => word !== '');
  if (words.length === 0) return rows;
  return rows.filter(row => {
    const text = `${row.name} ${row.summary} ${row.from}`.toLowerCase();
    return words.every(word => text.includes(word));
  });
}

/** The installs that are new since `before`, newest last as the machine lists them. */
export function newInstalls(
  before: readonly CatalogInstall[],
  after: readonly CatalogInstall[],
): readonly CatalogInstall[] {
  const seen = new Set(before.map(install => install.installId));
  return after.filter(install => !seen.has(install.installId));
}

const sameFolder = (a: string, b: string): boolean => normalizeProjectPath(a) === normalizeProjectPath(b);

/** What a landing sentence needs of an install: where it went, and what the skill is called. */
export interface Landing {
  readonly target: CatalogInstall['target'];
  readonly name: string;
}

/** Whether the session reads the place an install went to. */
export function readsPlace(install: Pick<Landing, 'target'>, plan: InstallPlan, harness: 'claude' | 'codex'): boolean {
  const { target } = install;
  if (target.scope === 'project')
    return (
      plan.projectRoot !== undefined && sameFolder(target.projectRoot, plan.projectRoot) && target.harness === harness
    );
  return plan.runtimeId !== undefined && target.runtime === plan.runtimeId;
}

const placeName = (install: Pick<Landing, 'target'>): string =>
  install.target.scope === 'project'
    ? `the project ${install.target.projectRoot}`
    : `the account ${install.target.runtime}`;

/**
 * Whether this install probably made the skills folder it went into: the session saw no skill of that kind
 * before. The daemon does not say, so this is a hint, worded as one.
 */
export function likelyNewFolder(install: Pick<Landing, 'target'>, before: SessionSkillsInventory): boolean {
  const kind = install.target.scope === 'project' ? 'project' : 'user';
  return !before.skills.some(skill => skill.scope === kind);
}

export const CLAUDE_LIVE = 'It is active in this session now.';
export const CLAUDE_RELOAD =
  'It may need /reload-skills in this session, because its skills folder was probably just created.';
export const CODEX_NEXT = 'It is active from the next session.';
export const NOT_HERE = 'This session does not read that place, so it is not active here.';

/** Where an install went and whether the running session sees it, in two short sentences. */
export function landedSentence(
  install: CatalogInstall,
  plan: InstallPlan,
  before: SessionSkillsInventory | null,
  harness: 'claude' | 'codex',
): string {
  return landingSentence({ target: install.target, name: install.provenance.name }, plan, before, harness);
}

/** The same two sentences for anything that landed: a catalog install or a copy from this machine. */
export function landingSentence(
  install: Landing,
  plan: InstallPlan,
  before: SessionSkillsInventory | null,
  harness: 'claude' | 'codex',
): string {
  const name = revealHidden(install.name);
  if (!readsPlace(install, plan, harness)) return `Installed ${name} on ${placeName(install)}. ${NOT_HERE}`;
  const where = install.target.scope === 'project' ? PROJECT_SENTENCE : plan.sentence;
  const activation =
    harness === 'codex'
      ? CODEX_NEXT
      : before !== null && likelyNewFolder(install, before)
        ? CLAUDE_RELOAD
        : CLAUDE_LIVE;
  return `Installed ${name} in ${where}. ${activation}`;
}
