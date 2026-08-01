import { describe, it } from 'bun:test';
import type { SessionView } from '@ferretry/protocol';
import should from 'should';
import type { UiControls } from '../../src/lib/controls.ts';
import {
  baseName,
  type FleetFilter,
  type FleetProject,
  filterSessions,
  fleetView,
  groupByProject,
  isScopeResolvable,
  modeCounts,
  normalizeProjectPath,
  projectKeyFor,
  scopeSessions,
  sessionInScope,
} from '../../src/lib/fleet-grouping.ts';
import type { DaemonFleetSlice } from '../../src/lib/fleet-store.ts';
import { sessionView } from '../support/sessions.ts';

const filter = (overrides: Partial<FleetFilter> = {}): FleetFilter => ({
  query: '',
  mode: 'all',
  rcOnly: false,
  includeFinished: false,
  ...overrides,
});

const slice = (sessions: readonly SessionView[] | null): DaemonFleetSlice => ({
  sessions,
  byId: new Map(sessions?.map(view => [view.config.id, view]) ?? []),
  status: sessions === null ? 'loading' : 'ready',
  error: null,
});

const controls = (overrides: Partial<UiControls> = {}): FleetFilter & Pick<UiControls, 'projectScope'> => ({
  ...filter(),
  projectScope: null,
  ...overrides,
});

const ids = (views: readonly SessionView[]): string[] => views.map(view => view.config.id);

describe('baseName', () => {
  it('names a path by its last segment', () => {
    should(baseName('/home/k/.config/home-manager')).equal('home-manager');
  });

  it('ignores trailing and repeated separators', () => {
    should(baseName('/home/k/ferretry//')).equal('ferretry');
  });

  it('reads a bare relative path as its own name', () => {
    should(baseName('ferretry')).equal('ferretry');
  });

  it('answers with the input when no segment can name it', () => {
    should(baseName('///')).equal('///');
  });
});

describe('normalizeProjectPath', () => {
  it('collapses a trailing-slash registration onto the bare path', () => {
    should(normalizeProjectPath('/work/repo/')).equal(normalizeProjectPath('/work/repo'));
  });

  it('keeps a bare root rather than emptying it', () => {
    should(normalizeProjectPath('/')).equal('/');
  });
});

describe('projectKeyFor', () => {
  const projects: readonly FleetProject[] = [
    { name: 'repo', path: '/work/repo' },
    { name: 'worktree', path: '/work/repo/wt/feature/' },
    { name: 'elsewhere', path: '/other' },
  ];

  it('files a cwd under the registered project that contains it', () => {
    should(projectKeyFor('/work/repo/src', projects)).eql({ key: '/work/repo', name: 'repo' });
  });

  it('files an exact registration match under itself', () => {
    should(projectKeyFor('/other', projects)).eql({ key: '/other', name: 'elsewhere' });
  });

  it('gives a nested worktree to the LONGEST prefix, not the parent repo', () => {
    should(projectKeyFor('/work/repo/wt/feature/pkg', projects)).eql({
      key: '/work/repo/wt/feature',
      name: 'worktree',
    });
  });

  it('does not treat a sibling sharing a name prefix as inside the project', () => {
    should(projectKeyFor('/work/repo-old/src', projects).key).equal('/work/repo-old/src');
  });

  it('falls back to the cwd basename when no project is registered', () => {
    should(projectKeyFor('/scratch/spike/', [])).eql({ key: '/scratch/spike', name: 'spike' });
  });

  it('calls a session with no cwd ungrouped', () => {
    should(projectKeyFor('', projects)).eql({ key: '', name: 'ungrouped' });
  });
});

describe('sessionInScope', () => {
  const view = sessionView('a', { config: { cwd: '/work/repo/src' } });

  it('admits everything when folder mode is off', () => {
    should(sessionInScope(view, [], null)).be.true();
  });

  it('matches a scope that differs only by a trailing separator', () => {
    should(sessionInScope(view, [{ name: 'repo', path: '/work/repo' }], '/work/repo/')).be.true();
  });

  it('rejects a session filed under another folder', () => {
    should(sessionInScope(view, [], '/elsewhere')).be.false();
  });
});

describe('scopeSessions', () => {
  const sessions = [
    sessionView('a', { config: { cwd: '/work/repo/src' } }),
    sessionView('b', { config: { cwd: '/other/thing' } }),
  ];

  it('passes the whole fleet through when unscoped', () => {
    should(ids(scopeSessions(sessions, [], null))).eql(['a', 'b']);
  });

  it('copies rather than returning the caller its own array', () => {
    should(scopeSessions(sessions, [], null)).not.equal(sessions);
  });

  it('narrows to one folder group when scoped', () => {
    should(ids(scopeSessions(sessions, [{ name: 'repo', path: '/work/repo' }], '/work/repo'))).eql(['a']);
  });
});

describe('isScopeResolvable', () => {
  const sessions = [sessionView('a', { config: { cwd: '/scratch/spike' } })];

  it('resolves a registered project path even with no sessions in it', () => {
    should(isScopeResolvable('/work/repo/', [], [{ name: 'repo', path: '/work/repo' }])).be.true();
  });

  it('resolves a cwd-fallback group that a live session sits in', () => {
    should(isScopeResolvable('/scratch/spike', sessions, [])).be.true();
  });

  it('does not resolve a folder this daemon has never reported', () => {
    should(isScopeResolvable('/from/other/daemon', sessions, [])).be.false();
  });
});

describe('filterSessions', () => {
  const sessions = [
    sessionView('alpha', { config: { name: 'Fix Transcript', mode: 'auto', remoteControl: false } }),
    sessionView('beta', { config: { name: 'Review PR', mode: 'interactive', remoteControl: true } }),
    sessionView('gamma', { config: { name: 'Old Work', mode: 'auto' }, state: { status: 'completed' } }),
  ];

  it('hides finished sessions by default', () => {
    should(ids(filterSessions(sessions, filter()))).eql(['alpha', 'beta']);
  });

  it('shows finished sessions when asked', () => {
    should(ids(filterSessions(sessions, filter({ includeFinished: true })))).containEql('gamma');
  });

  it('narrows to one interaction mode', () => {
    should(ids(filterSessions(sessions, filter({ mode: 'interactive' })))).eql(['beta']);
  });

  it('narrows to remote-controlled sessions', () => {
    should(ids(filterSessions(sessions, filter({ rcOnly: true })))).eql(['beta']);
  });

  it('matches the query against the session name, case-insensitively', () => {
    should(ids(filterSessions(sessions, filter({ query: '  transcript ' })))).eql(['alpha']);
  });

  it('lets a reader type a mode name as a search term', () => {
    should(ids(filterSessions(sessions, filter({ query: 'interactive' })))).eql(['beta']);
  });

  it('lets a reader type "rc" to find remote-controlled sessions', () => {
    should(ids(filterSessions(sessions, filter({ query: 'rc' })))).eql(['beta']);
  });

  it('matches the daemon-reported status', () => {
    should(ids(filterSessions(sessions, filter({ query: 'completed', includeFinished: true })))).eql(['gamma']);
  });

  it('matches optional identity fields when they are present', () => {
    const labelled = [
      sessionView('one', { config: { teammate: 'loge', label: 'batch-7', parent: 'lead', model: 'opus-5' } }),
    ];
    should(ids(filterSessions(labelled, filter({ query: 'batch-7' })))).eql(['one']);
    should(ids(filterSessions(labelled, filter({ query: 'opus-5' })))).eql(['one']);
  });

  it('drops a session that matches nothing in the query', () => {
    should(filterSessions(sessions, filter({ query: 'nothing-here' }))).be.empty();
  });
});

describe('modeCounts', () => {
  const sessions = [
    sessionView('a', { config: { mode: 'auto' } }),
    sessionView('b', { config: { mode: 'auto' } }),
    sessionView('c', { config: { mode: 'interactive' } }),
    sessionView('d', { config: { mode: 'auto' }, state: { status: 'completed' } }),
  ];

  it('counts what each segment would show under the OTHER filters', () => {
    should(modeCounts(sessions, filter())).eql({ all: 3, interactive: 1, auto: 2 });
  });

  it('does not let the current mode narrow its own counts', () => {
    should(modeCounts(sessions, filter({ mode: 'interactive' }))).eql({ all: 3, interactive: 1, auto: 2 });
  });

  it('follows the finished filter, so the numbers match the list', () => {
    should(modeCounts(sessions, filter({ includeFinished: true }))).eql({ all: 4, interactive: 1, auto: 3 });
  });
});

describe('groupByProject', () => {
  const projects: readonly FleetProject[] = [{ name: 'repo', path: '/work/repo' }];
  const sessions = [
    sessionView('a', { config: { cwd: '/work/repo/src' }, state: { lastActivityAt: '2026-01-01T00:00:01.000Z' } }),
    sessionView('b', { config: { cwd: '/scratch/spike' } }),
    sessionView('c', { config: { cwd: '/work/repo/pkg' }, state: { lastActivityAt: '2026-01-01T00:00:09.000Z' } }),
  ];

  it('files sessions under their registered project and orders the biggest group first', () => {
    const groups = groupByProject(sessions, projects);
    should(groups.map(group => group.name)).eql(['repo', 'spike']);
    should(ids(groups[0]!.rows)).eql(['a', 'c']);
    should(groups[0]!.path).equal('/work/repo');
  });

  it('preserves the daemon order inside a group by default', () => {
    should(ids(groupByProject(sessions, projects)[0]!.rows)).eql(['a', 'c']);
  });

  it('puts the newest life-sign first when asked to sort', () => {
    should(ids(groupByProject(sessions, projects, true)[0]!.rows)).eql(['c', 'a']);
  });

  it('falls back to updatedAt when a session has never reported activity', () => {
    const stale = [
      sessionView('old', {
        config: { cwd: '/g', updatedAt: '2026-01-01T00:00:00.000Z' },
        state: { lastActivityAt: undefined },
      }),
      sessionView('new', {
        config: { cwd: '/g', updatedAt: '2026-01-01T00:00:05.000Z' },
        state: { lastActivityAt: undefined },
      }),
    ];
    should(ids(groupByProject(stale, [], true)[0]!.rows)).eql(['new', 'old']);
  });

  it('sorts a session with no timestamp at all to the end instead of scrambling the order', () => {
    const mixed = [
      sessionView('unknown', {
        config: { cwd: '/g', updatedAt: undefined },
        state: { lastActivityAt: undefined },
      }),
      sessionView('known', { config: { cwd: '/g' }, state: { lastActivityAt: '2026-01-01T00:00:02.000Z' } }),
    ];
    should(ids(groupByProject(mixed, [], true)[0]!.rows)).eql(['known', 'unknown']);
  });

  it('breaks a size tie on the group name', () => {
    const tied = [sessionView('z', { config: { cwd: '/zeta' } }), sessionView('a', { config: { cwd: '/alpha' } })];
    should(groupByProject(tied, []).map(group => group.name)).eql(['alpha', 'zeta']);
  });

  it('groups nothing into nothing', () => {
    should(groupByProject([], projects)).be.empty();
  });
});

describe('fleetView', () => {
  const projects: readonly FleetProject[] = [{ name: 'repo', path: '/work/repo' }];
  const sessions = [
    sessionView('a', { config: { cwd: '/work/repo/src', mode: 'auto' } }),
    sessionView('b', { config: { cwd: '/scratch/spike', mode: 'interactive' } }),
    sessionView('c', { config: { cwd: '/work/repo/pkg', mode: 'auto' }, state: { status: 'completed' } }),
  ];

  it('renders nothing and keeps the stored scope while the first read is in flight', () => {
    const view = fleetView(slice(null), projects, controls({ projectScope: '/work/repo' }));
    should(view.sessions).be.empty();
    should(view.groups).be.empty();
    should(view.allGroups).be.empty();
    should(view.counts).eql({ all: 0, interactive: 0, auto: 0 });
    should(view.scope).equal('/work/repo');
    should(view.scopeRecovered).be.false();
  });

  it('shows the whole fleet when no folder is focused', () => {
    const view = fleetView(slice(sessions), projects, controls());
    should(ids(view.sessions)).eql(['a', 'b']);
    should(view.scope).be.null();
    should(view.scopeRecovered).be.false();
  });

  it('applies the folder scope before the filters', () => {
    const view = fleetView(slice(sessions), projects, controls({ projectScope: '/work/repo' }));
    should(ids(view.sessions)).eql(['a']);
    should(view.counts).eql({ all: 1, interactive: 0, auto: 1 });
    should(view.groups.map(group => group.name)).eql(['repo']);
  });

  it('offers every folder in the scoped fleet, including ones the filters emptied', () => {
    const view = fleetView(slice(sessions), projects, controls({ query: 'no-match-at-all' }));
    should(view.sessions).be.empty();
    should(view.allGroups.map(group => group.name)).eql(['repo', 'spike']);
  });

  it('keeps a scope whose sessions are merely filtered out of view', () => {
    const finishedOnly = [sessionView('c', { config: { cwd: '/work/repo/pkg' }, state: { status: 'completed' } })];
    const view = fleetView(slice(finishedOnly), projects, controls({ projectScope: '/work/repo' }));
    should(view.sessions).be.empty();
    should(view.scope).equal('/work/repo');
    should(view.scopeRecovered).be.false();
  });

  it('recovers from a scope this daemon has never heard of instead of showing an empty fleet', () => {
    const view = fleetView(slice(sessions), projects, controls({ projectScope: '/from/other/daemon' }));
    should(view.scope).be.null();
    should(view.scopeRecovered).be.true();
    should(ids(view.sessions)).eql(['a', 'b']);
  });

  it('sorts rows inside a group only when asked', () => {
    const busy = [
      sessionView('old', { config: { cwd: '/work/repo/a' }, state: { lastActivityAt: '2026-01-01T00:00:01.000Z' } }),
      sessionView('new', { config: { cwd: '/work/repo/b' }, state: { lastActivityAt: '2026-01-01T00:00:09.000Z' } }),
    ];
    should(ids(fleetView(slice(busy), projects, controls()).groups[0]!.rows)).eql(['old', 'new']);
    should(ids(fleetView(slice(busy), projects, controls(), true).groups[0]!.rows)).eql(['new', 'old']);
  });
});
