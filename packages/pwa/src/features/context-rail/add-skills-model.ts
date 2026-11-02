/**
 * "+ Add skills": what the page says and decides, as pure functions.
 *
 * The page installs through the existing review and hand-off, so the only decisions made here are the
 * default place (this project when the session has a folder, else this account), which skills to list,
 * and the sentence that says where an install landed and whether the running session already sees it.
 */

import {
  type CatalogInstall,
  revealHidden,
  type SessionSkillsInventory,
  type SharedCatalogManifestEntry,
} from '@ferretry/protocol';
import { type FleetProject, normalizeProjectPath } from '../../lib/fleet-grouping.ts';
import type { TargetDraft } from '../catalogs/catalog-install-model.ts';
import type { SharedCatalogView } from '../shared/shared-controller.ts';
import type { CardState } from '../shared/shared-screens-model.ts';

export const ADD_SKILLS_BUTTON = '+ Add skills';
export const ADD_SKILLS_TITLE = 'Add skills';
export const ADD_SKILLS_BACK = 'Back to the session';
export const ADD_SKILLS_SEARCH_LABEL = 'Search subscribed skills';
export const CATALOG_FILTER_LABEL = 'Filter by catalog';
const ALL_CATALOGS = 'All catalogs';
export const REFRESH_BUTTON = 'Refresh';
export const REFRESHING = 'Refreshing…';
export const REFRESHED = 'Up to date.';
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
  /** Which catalog it is in, across publishers: the filter and the group heading use it. */
  readonly catalogKey: string;
  readonly catalogName: string;
  readonly publisher: string;
  /** "publisher · catalog". */
  readonly from: string;
  readonly version: string;
  readonly installed: boolean;
}

/** The key one catalog goes by on the page: the publisher's id and the catalog's, so two publishers never collide. */
const catalogKey = (publisherId: string, catalogId: string): string => `${publisherId}/${catalogId}`;

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
            catalogKey: catalogKey(publisherId, block.catalogId),
            catalogName: block.name,
            publisher: publisherLabel,
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

/** One catalog the page can narrow to: All, then each catalog that lists a skill. */
export interface CatalogChip {
  readonly key: string;
  readonly label: string;
  readonly count: number;
}

export const ALL_CHIP = 'all';

/**
 * The catalog filter: All, then each catalog that lists a skill, in the order the publishers listed them. `kept` is
 * the rows the search already kept, so every count says how many skills that chip would show. A catalog whose name
 * another shares is named with its publisher.
 */
export function catalogChips(all: readonly SkillRow[], kept: readonly SkillRow[]): readonly CatalogChip[] {
  const catalogs = new Map<string, SkillRow>();
  for (const row of all) if (!catalogs.has(row.catalogKey)) catalogs.set(row.catalogKey, row);
  const named = new Map<string, number>();
  for (const row of catalogs.values()) named.set(row.catalogName, (named.get(row.catalogName) ?? 0) + 1);
  const chips = [...catalogs.values()].map(row => ({
    key: row.catalogKey,
    label: (named.get(row.catalogName) ?? 0) > 1 ? `${row.catalogName} (${row.publisher})` : row.catalogName,
    count: kept.filter(candidate => candidate.catalogKey === row.catalogKey).length,
  }));
  return catalogs.size < 2 ? [] : [{ key: ALL_CHIP, label: ALL_CATALOGS, count: kept.length }, ...chips];
}

/** A catalog's skills, under the catalog's name and who publishes it. */
export interface CatalogGroup {
  readonly key: string;
  readonly name: string;
  readonly publisher: string;
  readonly rows: readonly SkillRow[];
}

/** The rows of the chosen catalog (all of them for All), grouped by catalog in the order they came. */
export function groupByCatalog(rows: readonly SkillRow[], chip: string): readonly CatalogGroup[] {
  const groups = new Map<string, { name: string; publisher: string; rows: SkillRow[] }>();
  for (const row of rows) {
    if (chip !== ALL_CHIP && row.catalogKey !== chip) continue;
    const group = groups.get(row.catalogKey) ?? { name: row.catalogName, publisher: row.publisher, rows: [] };
    group.rows.push(row);
    groups.set(row.catalogKey, group);
  }
  return [...groups].map(([key, group]) => ({ key, ...group }));
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

/** Whether the session reads the place an install went to. */
export function readsPlace(install: CatalogInstall, plan: InstallPlan, harness: 'claude' | 'codex'): boolean {
  const { target } = install;
  if (target.scope === 'project')
    return (
      plan.projectRoot !== undefined && sameFolder(target.projectRoot, plan.projectRoot) && target.harness === harness
    );
  return plan.runtimeId !== undefined && target.runtime === plan.runtimeId;
}

const placeName = (install: CatalogInstall): string =>
  install.target.scope === 'project'
    ? `the project ${install.target.projectRoot}`
    : `the account ${install.target.runtime}`;

/**
 * Whether this install probably made the skills folder it went into: the session saw no skill of that kind
 * before. The daemon does not say, so this is a hint, worded as one.
 */
export function likelyNewFolder(install: CatalogInstall, before: SessionSkillsInventory): boolean {
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
  const name = revealHidden(install.provenance.name);
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
