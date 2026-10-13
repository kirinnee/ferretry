/**
 * PURE PROJECTIONS FOR THE ACCOUNT AND PROJECT PICKERS.
 *
 * `account-picker-catalog.ts`, `account-picker-store.ts` and `projects-store.ts`
 * own the daemon reads and their null-vs-empty discipline; this module turns
 * their raw shapes into option records a combobox can render and search
 * without re-deriving any of that discipline itself.
 *
 * RUNTIMES. `accountPickerOptions` takes the machine's runtimes, the cached
 * quota feed and the login health map as THREE SEPARATE inputs, because
 * they are three independent reads with three independent failure modes:
 * the runtimes are `GET /v1/fleet/runtimes`, quota rides the existing cached
 * `/v1/usage` feed (keyed by wrapper — `UsageAccountView.agent`), and health
 * is each login's status word from `GET /v1/fleet/credentials`. Options are
 * joined onto each runtime: quota by `wrapper`, health by `credentialId`. A
 * missing quota or health row stays missing on the option (`null`), never a
 * zero or a healthy guess. An unreadable roster projects to `null`; a
 * positively empty one projects to `[]`.
 *
 * PROJECTS. `projectPickerOptions` answers two questions with one call:
 * which folders has this daemon deliberately registered, and which OTHER
 * folders has a session actually used recently. A recent path that is a
 * registered project's root, or nested under one, is folded away — it is
 * not a second, competing way to reach the same place — using the exact
 * longest-prefix rule `fleet-grouping.ts` already applies to session
 * grouping (`projectKeyFor`), not a second copy of it. Registered and
 * recent options are two members of a discriminated union so that a
 * "recent" option is structurally unable to carry a registry `id`: nothing
 * about a recent path has been declared, and giving its option shape a slot
 * for one would let a caller *treat* it as declared by accident.
 *
 * NO SILENT DEFAULTS. Neither side of this module invents a value evidence
 * does not support. A blank model stays blank (`normalizedModelSelection`
 * never consults an account's `defaultModel`); an unreadable registry stays
 * `null` even when recent paths are still readable; an unreadable session
 * list makes recent options `null` too, because "recent" is a claim about
 * sessions this module cannot support without reading them.
 */

import type { SessionView, UsageAccountView } from '@ferretry/protocol';

import type { PickerAccount, PickerAccountHealth, RecentProjectPath } from '../lib/account-picker-catalog.ts';
import { recentProjectPaths } from '../lib/account-picker-catalog.ts';
import { baseName, type FleetProject, normalizeProjectPath, projectKeyFor } from '../lib/fleet-grouping.ts';

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/**
 * The cached quota feed's own row, narrowed to what a picker renders. Kept as
 * a small local pick from the wire type rather than a copy invented here, so
 * a field this module does not use (`provider`, `retryAt`, …) cannot silently
 * drift out of sync with the feed's real shape.
 */
export type AccountUsageRow = Pick<
  UsageAccountView,
  'agent' | 'fiveHourPercent' | 'weeklyPercent' | 'fiveHourResetAt' | 'weeklyResetAt' | 'atLimit' | 'authOk'
>;

export interface AccountPickerOption {
  /** Stable option identity: the runtime's id. */
  readonly key: string;
  /** The value a caller types as `agent` when starting or migrating a session. */
  readonly value: string;
  readonly id: string;
  readonly wrapper: string;
  readonly displayName: string;
  readonly kind: PickerAccount['kind'];
  /** An agent runtime: the only kind the daemon starts a session on. */
  readonly agent: boolean;
  /** The login it uses; its health is that login's status. */
  readonly credentialId: string;
  readonly defaultModel: string | null;
  readonly models: PickerAccount['models'];
  readonly available: boolean;
  readonly unavailableReason: string | null;
  /** The cached quota row joined by `wrapper`, or `null` when the feed has none. */
  readonly quota: AccountUsageRow | null;
  /** The login's status joined by `credentialId`, or `null` while it is unread. */
  readonly health: PickerAccountHealth | null;
  /** Lowercased haystack: display name, harness, wrapper, default model, declared model ids. */
  readonly searchText: string;
}

/**
 * How a person reads one runtime: its name — the one the Runtimes tab shows —
 * and, beneath it, the wrapper a session is started with.
 *
 * The id is plumbing. It stays reachable because it IS the submitted value and
 * two runtimes can share a display name, but it never leads. When the wrapper is
 * the name, printing it twice adds nothing, so `id` is then `null`. Both halves are wire fields read
 * verbatim: nothing here derives a name from an id's spelling.
 *
 * Every surface that names an offered account — the closed box, each row, the
 * migrate sheet's "current" and "requested" lines — reads this one projection,
 * so no two of them can disagree about which half leads.
 */
export interface AccountLabel {
  readonly name: string;
  readonly id: string | null;
}

export const accountLabel = (account: Pick<AccountPickerOption, 'displayName' | 'wrapper'>): AccountLabel => ({
  name: account.displayName,
  id: account.displayName === account.wrapper ? null : account.wrapper,
});

/**
 * How a person reads the account a SESSION runs on, from the wrapper id its
 * config records (`config.agent`) — the same `accountLabel` the pickers use, so
 * the sessions list, the header and the pickers cannot name one account two ways.
 *
 * A wrapper the roster does not hold — the account was removed, or renamed since
 * the session started — is shown as its id, because that id is then the only
 * true thing left to say. Whether to render anything while the roster is still
 * unread is the caller's decision, not a guess made here.
 */
export const sessionAccountLabel = (accounts: readonly PickerAccount[], agent: string): AccountLabel => {
  const account = accounts.find(candidate => candidate.wrapper === agent);
  return account === undefined ? { name: agent, id: null } : accountLabel(account);
};

const accountSearchText = (account: PickerAccount): string =>
  [
    account.displayName,
    account.kind,
    account.wrapper,
    account.defaultModel ?? '',
    ...account.models.map(model => model.id),
  ]
    .join(' ')
    .toLowerCase();

const accountPickerOption = (
  account: PickerAccount,
  usage: readonly AccountUsageRow[],
  health: ReadonlyMap<string, PickerAccountHealth> | null,
): AccountPickerOption => ({
  key: account.id,
  value: account.wrapper,
  id: account.id,
  wrapper: account.wrapper,
  displayName: account.displayName,
  kind: account.kind,
  agent: account.agent,
  credentialId: account.credentialId,
  defaultModel: account.defaultModel,
  models: account.models,
  available: account.available,
  unavailableReason: account.unavailableReason,
  quota: usage.find(row => row.agent === account.wrapper) ?? null,
  health: health?.get(account.credentialId) ?? null,
  searchText: accountSearchText(account),
});

/**
 * One option per runtime, in the daemon's own order. `null` when
 * the roster itself could not be read — distinct from a positively empty
 * fleet, which projects to `[]`. Unavailable accounts stay in the list as
 * disabled options carrying their `unavailableReason`; a caller decides how
 * to render that, this projection only refuses to hide it.
 */
export const accountPickerOptions = (
  accounts: readonly PickerAccount[] | null,
  usage: readonly AccountUsageRow[],
  health: ReadonlyMap<string, PickerAccountHealth> | null,
): readonly AccountPickerOption[] | null =>
  accounts === null ? null : accounts.map(account => accountPickerOption(account, usage, health));

/**
 * Narrow to one harness for a migration target, where cross-CLI migration is
 * never offered. An unreadable roster stays unreadable — filtering a `null`
 * roster is still a `null` roster, not an empty list that would read as "no
 * accounts exist".
 */
export const sameHarnessAccountOptions = (
  options: readonly AccountPickerOption[] | null,
  harness: PickerAccount['kind'],
): readonly AccountPickerOption[] | null =>
  options === null ? null : options.filter(option => option.kind === harness);

/**
 * Narrow to the runtimes the daemon can run a session on: its AGENT runtimes. A runtime without the
 * agent flag is the person's own CLI, and offering it only sets up a refusal. Read from the runtime's
 * own `agent` flag — never from the wrapper's spelling. An unreadable roster stays unreadable.
 */
export const sessionCapableAccountOptions = (
  options: readonly AccountPickerOption[] | null,
): readonly AccountPickerOption[] | null => (options === null ? null : options.filter(option => option.agent));

/**
 * The account a new-session form fills in before anybody chooses: the first one
 * offered that the machine says can launch, in the daemon's own order. `null`
 * when nothing offered is usable — the form then leaves the box empty rather than
 * pre-filling a row that would be refused.
 */
export const firstUsableAccountOption = (options: readonly AccountPickerOption[] | null): AccountPickerOption | null =>
  options?.find(option => option.available) ?? null;

/**
 * The runtime a launch hint names (`?agent=<name>`), by wrapper or by runtime name, honoured only
 * when it is offered AND can launch — a hint never pre-fills a row the daemon would refuse.
 */
export const hintedAccountOption = (
  options: readonly AccountPickerOption[] | null,
  hint: string | undefined,
): AccountPickerOption | null =>
  hint === undefined
    ? null
    : (options?.find(option => option.available && (option.wrapper === hint || option.displayName === hint)) ?? null);

/** How a harness reads on screen. */
export const fleetHarnessLabel = (harness: PickerAccount['kind']): 'Claude' | 'Codex' =>
  harness === 'claude' ? 'Claude' : 'Codex';

/** The option for a chosen wrapper, or `null` when it is absent or the roster is unread. */
export const findAccountOption = (
  options: readonly AccountPickerOption[] | null,
  wrapper: string,
): AccountPickerOption | null => options?.find(option => option.wrapper === wrapper) ?? null;

export interface AccountQuotaSummary {
  /** `null` = no evidence; a real reading of 0% used is returned as `0`, never dropped. */
  readonly fiveHourPercent: number | null;
  readonly weeklyPercent: number | null;
  /** `null` = unknown, distinct from a proven `false`. */
  readonly atLimit: boolean | null;
  readonly authOk: boolean | null;
}

/** Presentation-only facts: exhaustion or an auth failure here is advisory, never a disable decision. */
export const accountQuotaSummary = (quota: AccountUsageRow | null): AccountQuotaSummary => ({
  fiveHourPercent: quota?.fiveHourPercent ?? null,
  weeklyPercent: quota?.weeklyPercent ?? null,
  atLimit: quota?.atLimit ?? null,
  authOk: quota?.authOk ?? null,
});

/**
 * Normalizes typed model text with no reference to any account: blank stays
 * blank (`null`, meaning "use the account's own default"). This signature
 * cannot pin a default even by accident, because it is never handed one.
 */
export const normalizedModelSelection = (model: string): string | null => {
  const trimmed = model.trim();
  return trimmed === '' ? null : trimmed;
};

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

interface ProjectPickerOptionBase {
  /** Stable option identity and grouping key: the normalized canonical path. */
  readonly key: string;
  readonly name: string;
  readonly path: string;
  readonly searchText: string;
}

export interface RegisteredProjectOption extends ProjectPickerOptionBase {
  readonly kind: 'registered';
  /** Present only when the registry itself carried it — never synthesized. */
  readonly id?: string;
  readonly source?: FleetProject['source'];
  readonly createdAt?: string;
  readonly git?: FleetProject['git'];
}

/**
 * Structurally distinct from `RegisteredProjectOption`: this shape has no
 * `id` field at all, so a recent path can never be read or passed around as
 * though the daemon had declared it a Project.
 */
export interface RecentProjectOption extends ProjectPickerOptionBase {
  readonly kind: 'recent';
  readonly lastActivity: string;
}

export type ProjectPickerOption = RegisteredProjectOption | RecentProjectOption;

export interface ProjectPickerCatalog {
  /** `null` = registry unread; `[]` = the daemon registers no projects. */
  readonly registered: readonly RegisteredProjectOption[] | null;
  /** `null` = the session list itself is unread; recent paths need sessions to exist at all. */
  readonly recent: readonly RecentProjectOption[] | null;
}

const registeredProjectOption = (project: FleetProject): RegisteredProjectOption => {
  const path = normalizeProjectPath(project.path);
  return {
    kind: 'registered',
    key: path,
    name: project.name,
    path,
    ...(project.id === undefined ? {} : { id: project.id }),
    ...(project.source === undefined ? {} : { source: project.source }),
    ...(project.createdAt === undefined ? {} : { createdAt: project.createdAt }),
    ...(project.git === undefined ? {} : { git: project.git }),
    searchText: [project.name, path, project.source ?? ''].join(' ').toLowerCase(),
  };
};

/**
 * The registry protocol does not use a path as Project identity, so damaged or
 * legacy state may publish two records whose paths normalize to the same value.
 * A path picker cannot distinguish those rows and submits only the path anyway;
 * keep the daemon's first row and expose that canonical value once.
 */
const registeredProjectOptions = (projects: readonly FleetProject[]): readonly RegisteredProjectOption[] => {
  const options = new Map<string, RegisteredProjectOption>();
  for (const project of projects) {
    const option = registeredProjectOption(project);
    if (!options.has(option.path)) options.set(option.path, option);
  }
  return [...options.values()];
};

const recentProjectOption = (entry: RecentProjectPath): RecentProjectOption => {
  const path = normalizeProjectPath(entry.path);
  const name = baseName(path);
  return {
    kind: 'recent',
    key: path,
    name,
    path,
    lastActivity: entry.lastActivity,
    searchText: [name, path, 'recent'].join(' ').toLowerCase(),
  };
};

/**
 * True when `path` names a registered project's own root or a location
 * nested under it. Delegates the actual longest-prefix decision to
 * `projectKeyFor` — the same function session grouping uses — rather than
 * re-testing prefixes here, so the two can never disagree about what counts
 * as "under" a project.
 */
const foldedIntoRegistered = (path: string, projects: readonly FleetProject[]): boolean => {
  const { key } = projectKeyFor(path, projects);
  return projects.some(project => normalizeProjectPath(project.path) === key);
};

/**
 * Registered options mirror the registry's own null-vs-empty reading
 * directly. Recent options come from `recentProjectPaths`, newest first,
 * with anything already covered by a registered project folded away — an
 * unread registry folds against no known projects (so nothing is folded,
 * rather than guessing), and is never described as having produced these
 * as "registered". Recent options are `null` only when the session list
 * itself is unread; a positively empty registry does not suppress them.
 */
export const projectPickerOptions = (
  registry: readonly FleetProject[] | null,
  sessions: readonly SessionView[] | null,
): ProjectPickerCatalog => {
  const registered = registry === null ? null : registeredProjectOptions(registry);
  if (sessions === null) return { registered, recent: null };
  const knownProjects = registry ?? [];
  const recent = recentProjectPaths(sessions)
    .filter(entry => !foldedIntoRegistered(entry.path, knownProjects))
    .map(recentProjectOption);
  return { registered, recent };
};
