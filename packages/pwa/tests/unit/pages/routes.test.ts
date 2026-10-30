import { describe, it } from 'bun:test';
import should from 'should';
import { daemonId } from '../../../src/lib/daemon-connection.ts';
import {
  connectionPickerPath,
  daemonAgendaPath,
  daemonAnalyticsPath,
  daemonAnalyticsQueryPath,
  daemonBoardCardPath,
  daemonBoardForFerretPath,
  daemonBoardPath,
  daemonImportedHistoryPath,
  daemonLearningPath,
  daemonMachineSetupPath,
  daemonNewSessionPath,
  daemonProjectPath,
  daemonProjectsPath,
  daemonSessionPath,
  daemonSessionsPath,
  daemonSettingsPath,
  daemonWardenPath,
  decodeRouteSegment,
  parseRoute,
  type Route,
  routePageKey,
  routePath,
  setupPath,
} from '../../../src/lib/pages/routes.ts';

const daemonA = daemonId('daemon/a');
const daemonB = daemonId('daemon-b');

describe('route path builders', () => {
  it('should build every daemon destination with percent-encoded identity segments', () => {
    // Act
    const actual = [
      connectionPickerPath(),
      daemonSessionsPath(daemonA),
      daemonNewSessionPath(daemonA),
      daemonProjectsPath(daemonA),
      daemonProjectPath(daemonA, '11111111-1111-4111-8111-111111111111'),
      daemonSessionPath(daemonA, 'session / one'),
      daemonSettingsPath(daemonA),
      daemonWardenPath(daemonA),
      daemonAnalyticsPath(daemonA),
      daemonLearningPath(daemonA),
      daemonImportedHistoryPath(daemonA),
      daemonMachineSetupPath(daemonA),
    ];

    // Assert
    should(actual).deepEqual([
      '/',
      '/d/daemon%2Fa',
      '/d/daemon%2Fa/new',
      '/d/daemon%2Fa/projects',
      '/d/daemon%2Fa/projects/11111111-1111-4111-8111-111111111111',
      '/d/daemon%2Fa/session/session%20%2F%20one',
      '/d/daemon%2Fa/settings',
      '/d/daemon%2Fa/warden',
      '/d/daemon%2Fa/analytics',
      '/d/daemon%2Fa/learning',
      '/d/daemon%2Fa/history',
      '/d/daemon%2Fa/setup',
    ]);
  });

  it('should reject a blank session ID instead of producing a session pathname', () => {
    // Act
    const actual = (): unknown => daemonSessionPath(daemonA, ' ');

    // Assert
    should(actual).throw('sessionId must not be empty');
  });

  it('should reject a blank project ID instead of treating a path as identity', () => {
    should(() => daemonProjectPath(daemonA, ' ')).throw('projectId must not be empty');
  });

  it('should refuse to mint a project link for anything that is not a record UUID', () => {
    // Arrange — every one of these is a non-empty string somebody could plausibly
    // reach the builder with: a path, a folder name, a session id, a near-miss.
    const impostors = [
      '/work/ferretry',
      'ferretry',
      'project id',
      'session-one',
      '11111111-1111-4111-8111-11111111111',
      '11111111111141118111111111111111',
      'ZZZZZZZZ-1111-4111-8111-111111111111',
    ];

    // Act / Assert — the protocol says a path is not an identity, so the builder
    // refuses rather than minting a link that merely LOOKS like a project address.
    for (const impostor of impostors)
      should(() => daemonProjectPath(daemonA, impostor)).throw('projectId must be a registered project UUID');
  });
});

describe('route parsing', () => {
  it('should decode and resolve every canonical daemon page', () => {
    // Act
    const actual = [
      parseRoute('/d/daemon%2Fa'),
      parseRoute('/d/daemon%2Fa/new'),
      parseRoute('/d/daemon%2Fa/projects'),
      parseRoute('/d/daemon%2Fa/projects/11111111-1111-4111-8111-111111111111'),
      parseRoute('/d/daemon%2Fa/session/session%20%2F%20one'),
      parseRoute('/d/daemon%2Fa/settings'),
      parseRoute('/d/daemon%2Fa/warden'),
      parseRoute('/d/daemon%2Fa/analytics'),
      parseRoute('/d/daemon%2Fa/learning'),
      parseRoute('/d/daemon%2Fa/history'),
      parseRoute('/d/daemon%2Fa/setup'),
    ];

    // Assert
    should(actual).deepEqual([
      { kind: 'sessions', daemonId: daemonA },
      { kind: 'new-session', daemonId: daemonA },
      { kind: 'projects', daemonId: daemonA },
      { kind: 'project-detail', daemonId: daemonA, projectId: '11111111-1111-4111-8111-111111111111' },
      { kind: 'session', daemonId: daemonA, sessionId: 'session / one' },
      { kind: 'settings', daemonId: daemonA },
      { kind: 'warden', daemonId: daemonA },
      { kind: 'analytics', daemonId: daemonA },
      { kind: 'learning', daemonId: daemonA },
      { kind: 'imported-history', daemonId: daemonA },
      { kind: 'machine-setup', daemonId: daemonA },
    ]);
  });

  it('should preserve the daemon sessions fallback for unknown or incomplete daemon paths', () => {
    // Act
    const actual = [
      parseRoute('/d/daemon-b/unknown'),
      parseRoute('/d/daemon-b/session'),
      parseRoute('/d/daemon-b/session/'),
      parseRoute('/d/daemon-b/session/%20'),
      parseRoute('/d/daemon-b/session/one/extra'),
      parseRoute('/d/daemon-b/tasks/extra'),
      // THE RETIRED ACCOUNTS ADDRESS, asserted rather than merely deleted. Accounts is Fleet's child
      // panel inside one daemon's settings now, and a panel has no pathname — so an old bookmark is
      // an unknown daemon path like any other and lands on that daemon's sessions. It is emphatically
      // NOT redirected: there is no second way in, and `legacy-tasks-redirect` is the one
      // compatibility shim this router has.
      parseRoute('/d/daemon-b/accounts'),
    ];

    // Assert
    should(actual).deepEqual([
      { kind: 'sessions', daemonId: daemonB },
      { kind: 'sessions', daemonId: daemonB },
      { kind: 'sessions', daemonId: daemonB },
      { kind: 'sessions', daemonId: daemonB },
      { kind: 'sessions', daemonId: daemonB },
      { kind: 'sessions', daemonId: daemonB },
      { kind: 'sessions', daemonId: daemonB },
    ]);
  });

  it('should send a project segment that is not a record UUID to the registry, not to a detail screen', () => {
    // Act — a bookmark to a folder path, a typo, a truncated id, and the shape a
    // future sibling route would take.
    const actual = [
      parseRoute('/d/daemon-b/projects/project%20id'),
      parseRoute('/d/daemon-b/projects/%2Fwork%2Fferretry'),
      parseRoute('/d/daemon-b/projects/11111111-1111-4111-8111-11111111111'),
      parseRoute('/d/daemon-b/projects/new'),
      parseRoute('/d/daemon-b/projects/%20'),
    ];

    // Assert — the path names the projects destination and only the identity is
    // unusable, so the reader lands on the registry rather than on a screen
    // reporting a project that never existed as merely missing. It also keeps
    // `/projects/new` free to become its own route later instead of resolving to
    // a detail screen for a project called "new".
    should(actual).deepEqual([
      { kind: 'projects', daemonId: daemonB },
      { kind: 'projects', daemonId: daemonB },
      { kind: 'projects', daemonId: daemonB },
      { kind: 'projects', daemonId: daemonB },
      { kind: 'projects', daemonId: daemonB },
    ]);
  });

  it('should keep a valid record UUID reaching the detail screen', () => {
    // Act
    const actual = parseRoute('/d/daemon-b/projects/22222222-2222-4222-8222-222222222222');

    // Assert
    should(actual).deepEqual({
      kind: 'project-detail',
      daemonId: daemonB,
      projectId: '22222222-2222-4222-8222-222222222222',
    });
  });

  it('should redirect the legacy daemon tasks route to the board', () => {
    // Arrange
    const route = parseRoute('/d/daemon-b/tasks');

    // Act
    const actual = [route, routePath(route), routePageKey(route)];

    // Assert
    should(actual).deepEqual([
      { kind: 'legacy-tasks-redirect', to: { kind: 'board', daemonId: daemonB } },
      '/d/daemon-b/board',
      'board:"daemon-b"',
    ]);
  });

  it('should parse the board and a card opened on it, and write them back', () => {
    // Act
    const routes = [
      parseRoute('/d/daemon-b/board'),
      parseRoute('/d/daemon-b/board/F12'),
      parseRoute('/d/daemon-b/board/a%20b'),
    ];

    // Assert
    should(routes).deepEqual([
      { kind: 'board', daemonId: daemonB },
      { kind: 'board', daemonId: daemonB, taskId: 'F12' },
      { kind: 'board', daemonId: daemonB, taskId: 'a b' },
    ]);
    should([daemonBoardPath(daemonB), daemonBoardCardPath(daemonB, 'F12'), routePath(routes[1] as Route)]).deepEqual([
      '/d/daemon-b/board',
      '/d/daemon-b/board/F12',
      '/d/daemon-b/board/F12',
    ]);
    should(routePath(routes[0] as Route)).equal('/d/daemon-b/board');
    should(routePageKey(routes[1] as Route)).equal(routePageKey(routes[0] as Route));
  });

  it('narrows the board to one ferret, and marks one card when asked', () => {
    should(daemonBoardForFerretPath(daemonB, 'mvgt2oz9-04e28935')).equal('/d/daemon-b/board?ferret=mvgt2oz9-04e28935');
    should(daemonBoardForFerretPath(daemonB, 'mvgt2oz9-04e28935', 'F11')).equal(
      '/d/daemon-b/board?ferret=mvgt2oz9-04e28935&highlight=F11',
    );
    should(daemonBoardForFerretPath(daemonB, 'a b&c', 'F 1')).equal('/d/daemon-b/board?ferret=a+b%26c&highlight=F+1');
  });

  it('should send unscoped and invalid daemon paths to the connection picker', () => {
    // Act
    const actual = [parseRoute('/'), parseRoute('/unknown'), parseRoute('/d'), parseRoute('/d/%20')];

    // Assert
    should(actual).deepEqual([
      { kind: 'connection-picker' },
      { kind: 'connection-picker' },
      { kind: 'connection-picker' },
      { kind: 'connection-picker' },
    ]);
  });

  it('should give first-run setup its own durable address', () => {
    // Act — trailing slashes and sub-paths all land on the one guide, because
    // a reader who reloads mid-setup must not be told the page is gone.
    const actual = [parseRoute('/setup'), parseRoute('/setup/'), parseRoute('/setup/install')];

    // Assert
    should(actual).deepEqual([{ kind: 'setup' }, { kind: 'setup' }, { kind: 'setup' }]);
    should(setupPath()).equal('/setup');
  });

  it('should never throw when a pathname has malformed percent escapes', () => {
    // Act
    const actual = [decodeRouteSegment('%E0%A4%A'), parseRoute('/d/daemon-b/session/%E0%A4%A')];

    // Assert
    should(actual).deepEqual(['%E0%A4%A', { kind: 'session', daemonId: daemonB, sessionId: '%E0%A4%A' }]);
  });
});

describe('route identity', () => {
  it('should produce canonical paths and collision-safe page keys for every page kind', () => {
    // Arrange
    const daemonBSession = parseRoute('/d/daemon-b/session/same');
    const daemonASession = parseRoute('/d/daemon%2Fa/session/same');
    const routes = [
      parseRoute('/'),
      parseRoute('/setup'),
      parseRoute('/d/daemon-b'),
      parseRoute('/d/daemon-b/new'),
      parseRoute('/d/daemon-b/projects/22222222-2222-4222-8222-222222222222'),
      daemonBSession,
      daemonASession,
      parseRoute('/d/daemon-b/settings'),
      parseRoute('/d/daemon-b/warden'),
      parseRoute('/d/daemon-b/analytics'),
      parseRoute('/d/daemon-b/analytics/query'),
      parseRoute('/d/daemon-b/learning'),
      parseRoute('/d/daemon-b/history'),
      parseRoute('/d/daemon-b/setup'),
    ];

    // Act
    const actual = routes.map(route => [routePath(route), routePageKey(route)]);

    // Assert
    should(actual).deepEqual([
      ['/', 'connection-picker'],
      ['/setup', 'setup'],
      ['/d/daemon-b', 'sessions:"daemon-b"'],
      ['/d/daemon-b/new', 'new-session:"daemon-b"'],
      [
        '/d/daemon-b/projects/22222222-2222-4222-8222-222222222222',
        'project-detail:["daemon-b","22222222-2222-4222-8222-222222222222"]',
      ],
      ['/d/daemon-b/session/same', 'session:["daemon-b","same"]'],
      ['/d/daemon%2Fa/session/same', 'session:["daemon/a","same"]'],
      ['/d/daemon-b/settings', 'settings:"daemon-b"'],
      ['/d/daemon-b/warden', 'warden:"daemon-b"'],
      ['/d/daemon-b/analytics', 'analytics:"daemon-b"'],
      ['/d/daemon-b/analytics/query', 'analytics-query:"daemon-b"'],
      ['/d/daemon-b/learning', 'learning:"daemon-b"'],
      ['/d/daemon-b/history', 'imported-history:"daemon-b"'],
      ['/d/daemon-b/setup', 'machine-setup:"daemon-b"'],
    ]);
    should(routePageKey(daemonBSession)).not.equal(routePageKey(daemonASession));
  });
});

describe('the Analytics Query address', () => {
  it('parses as the Query view of Analytics and carries its query whole', () => {
    should(parseRoute('/d/daemon-b/analytics/query')).deepEqual({
      kind: 'analytics',
      daemonId: daemonId('daemon-b'),
      view: 'query',
    });
    should(parseRoute('/d/daemon-b/analytics/elsewhere').kind).equal('sessions');
    should(daemonAnalyticsQueryPath(daemonId('daemon-b'))).equal('/d/daemon-b/analytics/query');
    should(daemonAnalyticsQueryPath(daemonId('daemon-b'), '  ')).equal('/d/daemon-b/analytics/query');
    should(daemonAnalyticsQueryPath(daemonId('daemon-b'), ' sum(cost_usd) by (model) [7d] ')).equal(
      '/d/daemon-b/analytics/query?q=sum(cost_usd)%20by%20(model)%20%5B7d%5D',
    );
  });
});

describe('the Inbox route', () => {
  it('makes /inbox canonical and keeps /attention as a redirect to it', () => {
    const canonical = parseRoute('/d/daemon-b/inbox');
    const legacy = parseRoute('/d/daemon-b/attention');

    should(daemonAgendaPath(daemonB)).equal('/d/daemon-b/inbox');
    should(canonical).deepEqual({ kind: 'attention', daemonId: daemonB });
    should(legacy).deepEqual({
      kind: 'legacy-attention-redirect',
      to: { kind: 'attention', daemonId: daemonB },
    });
    should([routePath(legacy), routePageKey(legacy)]).deepEqual(['/d/daemon-b/inbox', routePageKey(canonical)]);
  });
});
