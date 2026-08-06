/**
 * FLEET FILTERING + PROJECT GROUPING — one implementation, every consumer.
 *
 * Ported from kteam `ui/src/lib/grouping.ts`. The dashboard and the persistent
 * sidebar answer the same question ("which sessions am I looking at, and whose
 * project are they in?") and MUST answer it identically: a session the sidebar
 * files under `nitroso` cannot appear under something else one column over.
 * Both read the same controls, so the only way they can still disagree is by
 * each carrying its own copy of the predicate — which is what this module
 * removes.
 *
 * Applied in this order:
 *   scopeSessions   — folder mode: narrow one daemon's fleet to ONE project
 *                     group (identity when unscoped), composed BEFORE the filters
 *   filterSessions  — the instant client-side filter (query + mode + rc + finished)
 *   modeCounts      — what each mode segment WOULD show, under the other filters
 *   groupByProject  — longest-project-path-prefix grouping, cwd basename fallback
 *
 * The per-session decision is factored into `projectKeyFor` so grouping and
 * scoping can NEVER disagree: the group header you tap to focus a folder and
 * the predicate that then narrows the list derive the key from the same code.
 *
 * WHAT CHANGED FOR FERRETRY — survey rows 46 and 48.
 *
 * kteam had one daemon, so a fleet was a module-global list and a scope was a
 * single un-namespaced string. Both assumptions break with two paired daemons:
 * a scope holds a DAEMON-DERIVED filesystem path, and session ids and cwds
 * collide freely across daemons.
 *
 * `controls.ts` already fixed the persistence half — `projectScope` is stored,
 * read and cleared per `DaemonId` with no daemon-free lookup. This module fixes
 * the PREDICATE half, and the enforcement is in the type: `fleetView` takes a
 * `DaemonFleetSlice`, which can only be obtained from
 * `FleetSnapshot.daemons.get(daemonId)`. There is no entry point that accepts a
 * bare session array alongside a scope, so a scope belonging to daemon A cannot
 * be evaluated against daemon B's rows — the mistake is unrepresentable rather
 * than merely discouraged.
 *
 * The lower-level predicates stay exported because they are what the tests pin
 * and what a screen composing its own view needs, but every one of them is pure
 * over the sessions it is handed and holds no cache of its own. There is
 * deliberately no memo table here: a cache keyed by anything less than the whole
 * `(daemonId, sessions, projects, controls)` tuple is exactly the cross-daemon
 * bug this port exists to prevent, and grouping a fleet is a linear pass over a
 * list a reader can actually scroll.
 *
 * PROJECTS ARE DAEMON-SCOPED. The durable `/v1/projects` registry is hydrated
 * by `projects-store.ts`; an unregistered session falls back to its cwd basename.
 * The registered-path branch picks the longest nested root, so a Git worktree
 * can remain beneath one explicitly registered Project without being enrolled
 * as another.
 */

import type { ProjectInfo, SessionView } from '@ferretry/protocol';
import { TERMINAL_STATUSES } from '../shell/status-mark.tsx';
import type { UiControls } from './controls.ts';
import type { DaemonFleetSlice } from './fleet-store.ts';

/**
 * The last path segment: `/home/k/.config/home-manager` → `home-manager`.
 *
 * Trailing separators are ignored so `/home/k/ferretry/` and `/home/k/ferretry`
 * read the same, and repeated separators collapse, because a project path is
 * whatever a daemon reported rather than a canonical string. A path that is all
 * separators has no segment to name it, so it answers with itself.
 */
export const baseName = (path: string): string => {
  const segments = path.split('/').filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1]! : path;
};

/**
 * A folder a daemon has registered as a project, as GROUPING reads it.
 *
 * Every field is `ProjectInfoSchema`'s own. `/v1/projects` has been served since
 * PR #136 and `@ferretry/protocol` owns that record, so this is a VIEW of it and
 * never a second declaration: a `source` the daemon adds cannot go stale here,
 * because the enum is picked from the wire type rather than retyped beside it.
 *
 * Only `name` and `path` are required, and that is a statement about grouping
 * rather than about the wire. `projectKeyFor` decides which of two nested roots
 * a session belongs to using nothing but the path, so a caller that has only
 * those two (a fixture, a folder a reader typed) is still a legal input. The
 * durable metadata is optional here and PRESENT in practice — the store hands
 * grouping whole parsed records — which is what lets a surface render
 * provenance without a second read.
 */
export type FleetProject = Readonly<Pick<ProjectInfo, 'name' | 'path'>> &
  Readonly<Partial<Pick<ProjectInfo, 'id' | 'source' | 'createdAt' | 'git'>>>;

/**
 * The four controls that narrow a fleet. Taken as a subset of `UiControls`
 * rather than redeclared, so a control cannot drift between what is persisted
 * and what is filtered on.
 */
export type FleetFilter = Pick<UiControls, 'query' | 'mode' | 'rcOnly' | 'includeFinished'>;

/**
 * Everything the instant query matches against, lowercased.
 *
 * `mode` is in the haystack so typing "interactive" filters, and RC sessions
 * answer to a literal "rc" — both are things a reader types expecting a result,
 * and both also exist as real filters for when they want precision.
 */
const haystack = (view: SessionView): string => {
  const { config, state } = view;
  return [
    config.id,
    config.teammate,
    config.name,
    config.label,
    config.parent,
    config.agent,
    config.model,
    config.modelHint,
    config.cwd,
    config.mode,
    state.status,
    config.remoteControl ? 'rc remote-control' : '',
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
};

/**
 * True when this session survives every filter EXCEPT the mode segment. Used by
 * the filter itself and by the counts, so the number on a segment is computed
 * from the same predicate that produced the list underneath it.
 */
const passesNonMode = (view: SessionView, filter: FleetFilter, needle: string): boolean => {
  if (!filter.includeFinished && TERMINAL_STATUSES.has(view.state.status)) return false;
  if (filter.rcOnly && !view.config.remoteControl) return false;
  if (needle === '') return true;
  return haystack(view).includes(needle);
};

export const filterSessions = (sessions: readonly SessionView[], filter: FleetFilter): SessionView[] => {
  const needle = filter.query.trim().toLowerCase();
  return sessions.filter(
    view => passesNonMode(view, filter, needle) && (filter.mode === 'all' || view.config.mode === filter.mode),
  );
};

export interface ModeCounts {
  readonly all: number;
  readonly interactive: number;
  readonly auto: number;
}

/**
 * Counts for the mode segment, over everything the OTHER filters admit — so
 * each number describes what tapping that segment would show, rather than an
 * unrelated fleet-wide total that never matches the list underneath it.
 */
export const modeCounts = (sessions: readonly SessionView[], filter: FleetFilter): ModeCounts => {
  const needle = filter.query.trim().toLowerCase();
  const pool = sessions.filter(view => passesNonMode(view, filter, needle));
  return {
    all: pool.length,
    interactive: pool.filter(view => view.config.mode === 'interactive').length,
    auto: pool.filter(view => view.config.mode === 'auto').length,
  };
};

export interface SessionGroup {
  readonly name: string;
  /** The group KEY, not a display path. See `projectKeyFor`. */
  readonly path: string;
  readonly rows: readonly SessionView[];
}

/**
 * Newest life-sign first. The sidebar is a live list: the teammate that just
 * said something is the one you want at the top of its project, not whichever
 * one the daemon happened to enumerate first.
 *
 * A session with neither timestamp sorts last rather than throwing the
 * comparator into `NaN`, which in a sort is an unordered result, not an error
 * anyone would see.
 */
const activityAt = (view: SessionView): number => {
  const parsed = Date.parse(view.state.lastActivityAt ?? view.config.updatedAt ?? '');
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
};

const byActivity = (left: SessionView, right: SessionView): number => activityAt(right) - activityAt(left);

/**
 * Strips trailing separators for prefix comparison, keeping a bare root.
 *
 * Registered project paths are NOT guaranteed canonical — no trailing-slash
 * rule, no symlink resolution. Routing both grouping and scope equality through
 * this one normaliser is the mitigation: a `…/repo` and a `…/repo/`
 * registration collapse to the same key, so a scope set from one still matches
 * sessions filed under the other.
 */
export const normalizeProjectPath = (path: string): string => {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed === '' ? path : trimmed;
};

/**
 * The group a session belongs to.
 *
 * `key` is the STABLE identity used everywhere scope is compared or persisted —
 * a normalised registered project path, or the session's own normalised cwd
 * when it matches no known project. `name` is only for display. Names collide
 * across distinct paths; keys cannot, which is why folder mode scopes on the
 * key and never on the name.
 *
 * The LONGEST registered path that prefixes the cwd wins, so a worktree nested
 * inside a repo files under the worktree rather than the parent.
 */
export interface ProjectKey {
  readonly key: string;
  readonly name: string;
}

export const projectKeyFor = (cwd: string, projects: readonly FleetProject[]): ProjectKey => {
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
  if (best) return { key: normalizeProjectPath(best.path), name: best.name };
  return { key: target, name: target === '' ? 'ungrouped' : baseName(target) };
};

/**
 * True when a session falls in the active folder scope. `scope === null` means
 * "no folder mode" and admits everything. `scope` is a group KEY, never a name.
 */
export const sessionInScope = (view: SessionView, projects: readonly FleetProject[], scope: string | null): boolean =>
  scope === null || projectKeyFor(view.config.cwd, projects).key === normalizeProjectPath(scope);

/**
 * Folder mode: narrow one daemon's fleet to a single project group. Applied
 * BEFORE the four filters and replacing none of them; an identity pass-through
 * when unscoped, so the feature degrades to whole-fleet behaviour the instant
 * `scope` is null.
 */
export const scopeSessions = (
  sessions: readonly SessionView[],
  projects: readonly FleetProject[],
  scope: string | null,
): SessionView[] => (scope === null ? [...sessions] : sessions.filter(view => sessionInScope(view, projects, scope)));

/**
 * A scope is RESOLVABLE when it names a real folder for THIS daemon: a
 * registered project path, or the group key of at least one session in its
 * UNFILTERED fleet (which covers cwd-fallback groups).
 *
 * Computed over the unfiltered list on purpose. A folder whose sessions are all
 * finished while "include finished" is off is *filtered-empty* — the scope is
 * still real and must be preserved — not *missing*, which is the only case that
 * should silently drop a reader back to the whole fleet.
 *
 * This is the check that makes per-daemon scope storage useful: daemon B's
 * remembered scope names a path daemon A has never heard of, so switching
 * daemon resolves against B's own rows and recovers instead of showing an empty
 * fleet.
 */
export const isScopeResolvable = (
  scope: string,
  sessions: readonly SessionView[],
  projects: readonly FleetProject[],
): boolean => {
  const target = normalizeProjectPath(scope);
  if (projects.some(project => normalizeProjectPath(project.path) === target)) return true;
  return sessions.some(view => projectKeyFor(view.config.cwd, projects).key === target);
};

/**
 * Group by project: the LONGEST registered path that prefixes the cwd wins, and
 * a cwd under no known project falls back to its own basename so nothing is
 * orphaned. Delegates the per-session decision to `projectKeyFor` so scoping can
 * never file a session differently.
 *
 * `sortRows` is opt-in because the dashboard preserves the daemon's order while
 * the sidebar wants most-recent-first. Groups are ordered by size then name, so
 * the busiest folder leads and ties stay stable across reads.
 */
export const groupByProject = (
  sessions: readonly SessionView[],
  projects: readonly FleetProject[],
  sortRows = false,
): SessionGroup[] => {
  const groups = new Map<string, { name: string; path: string; rows: SessionView[] }>();
  for (const view of sessions) {
    const { key, name } = projectKeyFor(view.config.cwd, projects);
    const existing = groups.get(key);
    if (existing) existing.rows.push(view);
    else groups.set(key, { name, path: key, rows: [view] });
  }
  const ordered = [...groups.values()];
  if (sortRows) for (const group of ordered) group.rows.sort(byActivity);
  return ordered.sort((left, right) => right.rows.length - left.rows.length || left.name.localeCompare(right.name));
};

/** Everything a fleet screen renders, derived in one pass from one daemon. */
export interface FleetView {
  /** Survivors of scope AND the four filters, in daemon order. */
  readonly sessions: readonly SessionView[];
  /** Those survivors grouped by project. */
  readonly groups: readonly SessionGroup[];
  /** Every group in the scoped-but-unfiltered fleet, for the folder picker. */
  readonly allGroups: readonly SessionGroup[];
  readonly counts: ModeCounts;
  /**
   * The scope actually applied. `null` when unscoped OR when the stored scope
   * named no folder this daemon knows, which is the recovery a screen should
   * write back rather than leaving a reader stuck on an empty list.
   */
  readonly scope: string | null;
  /** True when a stored scope was dropped, so the caller can persist the clear. */
  readonly scopeRecovered: boolean;
}

/**
 * The composed fleet view for ONE paired daemon.
 *
 * Takes a `DaemonFleetSlice` rather than a session array so a scope cannot be
 * evaluated against another daemon's rows: a slice is only reachable through
 * `FleetSnapshot.daemons.get(daemonId)`, and the `projectScope` handed in comes
 * from `controlsFor(record, daemonId)`. Both sides of the pair are therefore
 * addressed by the same `DaemonId` at the call site, and neither can be
 * supplied without it.
 *
 * A slice whose `sessions` is still `null` has not been read yet, which is a
 * different fact from an empty fleet. It yields empty everything and reports
 * NO scope recovery — a scope must never be cleared on the strength of a list
 * that has not arrived, or a reader's folder choice evaporates on every reload.
 */
export const fleetView = (
  slice: DaemonFleetSlice,
  projects: readonly FleetProject[],
  controls: FleetFilter & Pick<UiControls, 'projectScope'>,
  sortRows = false,
): FleetView => {
  const sessions = slice.sessions;
  if (sessions === null) {
    return {
      sessions: [],
      groups: [],
      allGroups: [],
      counts: { all: 0, interactive: 0, auto: 0 },
      scope: controls.projectScope,
      scopeRecovered: false,
    };
  }
  const stored = controls.projectScope;
  const resolvable = stored !== null && isScopeResolvable(stored, sessions, projects);
  const scope = resolvable ? stored : null;
  const scoped = scopeSessions(sessions, projects, scope);
  const visible = filterSessions(scoped, controls);
  return {
    sessions: visible,
    groups: groupByProject(visible, projects, sortRows),
    allGroups: groupByProject(scoped, projects, sortRows),
    counts: modeCounts(scoped, controls),
    scope,
    scopeRecovered: stored !== null && !resolvable,
  };
};
