/**
 * "+ Add skills": what the page says and decides, as pure functions. Copied from today's `add-skills-model.ts`, less the
 * group of skills on this machine (owner decision !A466).
 *
 * The page installs through the existing review and hand-off, so the only decisions made here are the default place
 * (this project when the ferret has a folder a registered project holds, else this account), which skills to list, and
 * the sentence that says where an install landed and whether the running ferret already sees it.
 */

import { type CatalogInstall, type SharedCatalogManifestEntry } from '../../../contract/wire/index.ts';
import { revealHidden } from '../../../contract/wire/shared-catalog-review.ts';
import { relativeWords } from '../../shell.ts';
import type { TargetDraft } from '../catalogs/catalog-install-model.ts';
import type { SharedCatalogView } from '../shared/shared-controller.ts';
import type { CardState } from '../shared/shared-screens-model.ts';

export const ADD_SKILLS_BUTTON = '+ Add skills';
export const ADD_SKILLS_TITLE = 'Add skills';
export const ADD_SKILLS_BACK = 'Back to the ferret';
export const ADD_SKILLS_SEARCH_LABEL = 'Search skills';
export const CATALOG_FILTER_LABEL = 'Filter by catalog';
const ALL_CATALOGS = 'All catalogs';
export const REFRESH_BUTTON = 'Refresh';
export const REFRESHING = 'Refreshing…';
export const SUBSCRIBE_WITH_LINK = 'Subscribe with a link…';
export const INSTALL_BUTTON = 'Install';
export const INSTALLED_LABEL = 'Installed';
export const NO_SUBSCRIPTIONS = 'You do not subscribe to any catalog yet. Subscribe with a link to find skills.';
export const NO_SKILLS_FOUND = 'No subscribed skill matches that.';
export const READING_SUBSCRIPTIONS = 'Reading your subscriptions…';
export const PICK_A_PLACE = 'You will pick where to install it.';

/** What the page knows of the ferret it was opened from. */
export interface SessionPlace {
  /** The ferret's working folder. */
  readonly cwd: string | undefined;
  readonly harness: 'claude' | 'codex';
  /** The runtime's wrapper name, as the skills inventory names it. */
  readonly runtime: string | undefined;
}

/** A registered project, as the default place needs it. */
export interface PlaceProject {
  readonly name: string;
  readonly path: string;
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

const PROJECT_SENTENCE = 'this project (every ferret in this folder)';
export const accountSentence = (runtime: string): string => `this account (every ferret on ${runtime})`;

/** A folder path with no trailing slash, so two spellings of one folder compare equal. */
export const normalizeProjectPath = (path: string): string => (path.length > 1 ? path.replace(/\/+$/u, '') : path);

/** The registered project that holds `cwd`, the longest path winning, so a nested folder finds its own. */
export function projectHolding(cwd: string, projects: readonly PlaceProject[]): PlaceProject | undefined {
  const target = normalizeProjectPath(cwd);
  let best: PlaceProject | undefined;
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

/** This project when the ferret sits in one, else this account; neither when neither can be told. */
export function installPlan(
  place: SessionPlace,
  projects: readonly PlaceProject[],
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
  readonly publisherId: string;
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
            publisherId,
            catalogKey: catalogKey(publisherId, block.catalogId),
            catalogName: block.name,
            publisher: publisherLabel,
            from: `${publisherLabel} · ${block.name}`,
            version: `v${String(item.entry.version)}`,
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
  readonly publisherId: string;
  readonly rows: readonly SkillRow[];
}

/** The rows of the chosen catalog (all of them for All), grouped by catalog in the order they came. */
export function groupByCatalog(rows: readonly SkillRow[], chip: string): readonly CatalogGroup[] {
  const groups = new Map<string, { name: string; publisher: string; publisherId: string; rows: SkillRow[] }>();
  for (const row of rows) {
    if (chip !== ALL_CHIP && row.catalogKey !== chip) continue;
    const group = groups.get(row.catalogKey) ?? {
      name: row.catalogName,
      publisher: row.publisher,
      publisherId: row.publisherId,
      rows: [],
    };
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

/** Whether the ferret reads the place an install went to. */
export function readsPlace(
  install: Pick<CatalogInstall, 'target'>,
  plan: InstallPlan,
  harness: 'claude' | 'codex',
): boolean {
  const { target } = install;
  if (target.scope === 'project')
    return (
      plan.projectRoot !== undefined && sameFolder(target.projectRoot, plan.projectRoot) && target.harness === harness
    );
  return plan.runtimeId !== undefined && target.runtime === plan.runtimeId;
}

const placeName = (install: Pick<CatalogInstall, 'target'>): string =>
  install.target.scope === 'project'
    ? `the project ${install.target.projectRoot}`
    : `the account ${install.target.runtime}`;

/**
 * Whether this install probably made the skills folder it went into: the ferret saw no skill of that kind before. The
 * daemon does not say, so this is a hint, worded as one. `scopes` is where the skills it saw came from.
 */
export function likelyNewFolder(install: Pick<CatalogInstall, 'target'>, scopes: readonly string[]): boolean {
  const kind = install.target.scope === 'project' ? 'project' : 'user';
  return !scopes.includes(kind);
}

const CLAUDE_LIVE = 'It is active in this ferret now.';
const CLAUDE_RELOAD = 'It may need /reload-skills in this ferret, because its skills folder was probably just created.';
const CODEX_NEXT = 'It is active from the next ferret you start.';
const NOT_HERE = 'This ferret does not read that place, so it is not active here.';

/** Where an install went and whether the running ferret sees it, in two short sentences. */
export function landedSentence(
  install: CatalogInstall,
  plan: InstallPlan,
  scopes: readonly string[],
  harness: 'claude' | 'codex',
): string {
  const name = revealHidden(install.provenance.name);
  if (!readsPlace(install, plan, harness)) return `Installed ${name} on ${placeName(install)}. ${NOT_HERE}`;
  const where = install.target.scope === 'project' ? PROJECT_SENTENCE : plan.sentence;
  const activation = harness === 'codex' ? CODEX_NEXT : likelyNewFolder(install, scopes) ? CLAUDE_RELOAD : CLAUDE_LIVE;
  return `Installed ${name} in ${where}. ${activation}`;
}

/** Beside Refresh: when the lists were last read, in words that stay true as the minutes pass. */
export const updatedLine = (at: number, now: number): string =>
  `Updated ${relativeWords(new Date(at).toISOString(), now)}`;

const joinNames = (names: readonly string[]): string =>
  names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/** Beside Refresh when a publisher did not answer: which, and that the list on screen is the earlier read. */
export const unreachableLine = (names: readonly string[]): string =>
  `Could not reach ${joinNames(names)}, so the list may be out of date.`;
