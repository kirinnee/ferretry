import { describe, it } from 'bun:test';
import should from 'should';
import { daemonId } from '../../../src/lib/daemon-connection.ts';
import {
  connectionPickerPath,
  daemonAnalyticsPath,
  daemonLearningPath,
  daemonNewSessionPath,
  daemonSessionPath,
  daemonSessionsPath,
  daemonSettingsPath,
  daemonWardenPath,
  decodeRouteSegment,
  parseRoute,
  routePageKey,
  routePath,
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
      daemonSessionPath(daemonA, 'session / one'),
      daemonSettingsPath(daemonA),
      daemonWardenPath(daemonA),
      daemonAnalyticsPath(daemonA),
      daemonLearningPath(daemonA),
    ];

    // Assert
    should(actual).deepEqual([
      '/',
      '/d/daemon%2Fa',
      '/d/daemon%2Fa/new',
      '/d/daemon%2Fa/session/session%20%2F%20one',
      '/d/daemon%2Fa/settings',
      '/d/daemon%2Fa/warden',
      '/d/daemon%2Fa/analytics',
      '/d/daemon%2Fa/learning',
    ]);
  });

  it('should reject a blank session ID instead of producing a session pathname', () => {
    // Act
    const actual = (): unknown => daemonSessionPath(daemonA, ' ');

    // Assert
    should(actual).throw('sessionId must not be empty');
  });
});

describe('route parsing', () => {
  it('should decode and resolve every canonical daemon page', () => {
    // Act
    const actual = [
      parseRoute('/d/daemon%2Fa'),
      parseRoute('/d/daemon%2Fa/new'),
      parseRoute('/d/daemon%2Fa/session/session%20%2F%20one'),
      parseRoute('/d/daemon%2Fa/settings'),
      parseRoute('/d/daemon%2Fa/warden'),
      parseRoute('/d/daemon%2Fa/analytics'),
      parseRoute('/d/daemon%2Fa/learning'),
    ];

    // Assert
    should(actual).deepEqual([
      { kind: 'sessions', daemonId: daemonA },
      { kind: 'new-session', daemonId: daemonA },
      { kind: 'session', daemonId: daemonA, sessionId: 'session / one' },
      { kind: 'settings', daemonId: daemonA },
      { kind: 'warden', daemonId: daemonA },
      { kind: 'analytics', daemonId: daemonA },
      { kind: 'learning', daemonId: daemonA },
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
    ];

    // Assert
    should(actual).deepEqual([
      { kind: 'sessions', daemonId: daemonB },
      { kind: 'sessions', daemonId: daemonB },
      { kind: 'sessions', daemonId: daemonB },
      { kind: 'sessions', daemonId: daemonB },
      { kind: 'sessions', daemonId: daemonB },
      { kind: 'sessions', daemonId: daemonB },
    ]);
  });

  it('should redirect the legacy daemon tasks route to canonical sessions', () => {
    // Arrange
    const route = parseRoute('/d/daemon-b/tasks');

    // Act
    const actual = [route, routePath(route), routePageKey(route)];

    // Assert
    should(actual).deepEqual([
      { kind: 'legacy-tasks-redirect', to: { kind: 'sessions', daemonId: daemonB } },
      '/d/daemon-b',
      'sessions:"daemon-b"',
    ]);
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
      parseRoute('/d/daemon-b'),
      parseRoute('/d/daemon-b/new'),
      daemonBSession,
      daemonASession,
      parseRoute('/d/daemon-b/settings'),
      parseRoute('/d/daemon-b/warden'),
      parseRoute('/d/daemon-b/analytics'),
      parseRoute('/d/daemon-b/learning'),
    ];

    // Act
    const actual = routes.map(route => [routePath(route), routePageKey(route)]);

    // Assert
    should(actual).deepEqual([
      ['/', 'connection-picker'],
      ['/d/daemon-b', 'sessions:"daemon-b"'],
      ['/d/daemon-b/new', 'new-session:"daemon-b"'],
      ['/d/daemon-b/session/same', 'session:["daemon-b","same"]'],
      ['/d/daemon%2Fa/session/same', 'session:["daemon/a","same"]'],
      ['/d/daemon-b/settings', 'settings:"daemon-b"'],
      ['/d/daemon-b/warden', 'warden:"daemon-b"'],
      ['/d/daemon-b/analytics', 'analytics:"daemon-b"'],
      ['/d/daemon-b/learning', 'learning:"daemon-b"'],
    ]);
    should(routePageKey(daemonBSession)).not.equal(routePageKey(daemonASession));
  });
});
