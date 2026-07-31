import { describe, it } from 'bun:test';
import should from 'should';
import {
  CURRENT_LAYOUT_VERSION,
  createFoundationPaths,
  createSessionPaths,
  decideIndexSchema,
  decideLayout,
  decideSessionMarker,
  InvalidStateHomeError,
  indexFiles,
  isPathInside,
  parseSessionId,
  requiredLayoutDirectories,
  resolveStateHome,
  StateHomeLayoutError,
  temporaryFilePath,
  tryParseSessionId,
} from '../../src/lib/index.ts';

describe('state-home resolution', () => {
  it.each([
    {
      name: 'explicit override',
      input: { fyHome: '/var/tmp/fy-state', homeDirectory: '/users/operator' },
      expected: '/var/tmp/fy-state',
    },
    {
      name: 'default below the user home',
      input: { fyHome: undefined, homeDirectory: '/users/operator' },
      expected: '/users/operator/.ferretry',
    },
    {
      name: 'normalized trailing separators',
      input: { fyHome: '/var/tmp/fy-state///', homeDirectory: '/users/operator' },
      expected: '/var/tmp/fy-state/',
    },
  ])('should resolve $name', ({ input, expected }) => {
    // Act
    const actual = resolveStateHome(input);

    // Assert
    should(actual).equal(expected);
  });

  it('should reject unsafe state-home inputs', () => {
    // Arrange
    const inputs = [
      { fyHome: '', homeDirectory: '/users/operator' },
      { fyHome: 'relative/state', homeDirectory: '/users/operator' },
      { fyHome: '~/state', homeDirectory: '/users/operator' },
      { fyHome: '/', homeDirectory: '/users/operator' },
      { fyHome: undefined, homeDirectory: '' },
      { fyHome: undefined, homeDirectory: 'relative/home' },
    ];

    // Act + Assert
    for (const input of inputs) should(() => resolveStateHome(input)).throw(InvalidStateHomeError);
  });
});

describe('foundation paths', () => {
  it('should keep configuration, derived state, sessions, and fleet manifest in separate namespaces', () => {
    // Arrange
    const home = resolveStateHome({ fyHome: '/tmp/fy-home', homeDirectory: '/unused' });

    // Act
    const actual = createFoundationPaths(home);

    // Assert
    should(actual).deepEqual({
      home: '/tmp/fy-home',
      layoutVersion: '/tmp/fy-home/layout-version',
      daemonLock: '/tmp/fy-home/daemon.lock',
      config: '/tmp/fy-home/config',
      daemonConfig: '/tmp/fy-home/config/daemon.json',
      routingCatalog: '/tmp/fy-home/config/routing.json',
      fleet: '/tmp/fy-home/fleet',
      fleetManifest: '/tmp/fy-home/fleet/manifest.json',
      state: '/tmp/fy-home/state',
      index: '/tmp/fy-home/state/index',
      sessionIndex: '/tmp/fy-home/state/index/sessions.sqlite',
      sessions: '/tmp/fy-home/state/sessions',
      temporary: '/tmp/fy-home/state/tmp',
    });
    should(requiredLayoutDirectories(actual)).deepEqual([
      '/tmp/fy-home',
      '/tmp/fy-home/config',
      '/tmp/fy-home/fleet',
      '/tmp/fy-home/state',
      '/tmp/fy-home/state/index',
      '/tmp/fy-home/state/sessions',
      '/tmp/fy-home/state/tmp',
    ]);
    should(indexFiles(actual)).deepEqual([
      '/tmp/fy-home/state/index/sessions.sqlite',
      '/tmp/fy-home/state/index/sessions.sqlite-wal',
      '/tmp/fy-home/state/index/sessions.sqlite-shm',
    ]);
  });

  it('should build paths only from a parsed session id', () => {
    // Arrange
    const paths = createFoundationPaths(resolveStateHome({ fyHome: '/tmp/fy-home', homeDirectory: '/unused' }));
    const input = parseSessionId('session-01');

    // Act
    const actual = createSessionPaths(paths, input);

    // Assert
    should(actual).deepEqual({
      directory: '/tmp/fy-home/state/sessions/session-01',
      marker: '/tmp/fy-home/state/sessions/session-01/session-version',
      config: '/tmp/fy-home/state/sessions/session-01/config.json',
      state: '/tmp/fy-home/state/sessions/session-01/state.json',
      events: '/tmp/fy-home/state/sessions/session-01/events.jsonl',
    });
  });

  it('should contain destructive and temporary paths within the state home', () => {
    // Arrange
    const paths = createFoundationPaths(resolveStateHome({ fyHome: '/tmp/fy-home', homeDirectory: '/unused' }));

    // Act
    const actual = temporaryFilePath(paths, paths.daemonConfig, 'abc-123');

    // Assert
    should(actual).equal('/tmp/fy-home/state/tmp/daemon.json.abc-123.tmp');
    should(isPathInside(paths.home, actual)).be.true();
    should(isPathInside(paths.home, '/tmp/fy-home-other/file')).be.false();
    should(() => temporaryFilePath(paths, '/tmp/outside', 'abc')).throw();
    should(() => temporaryFilePath(paths, paths.daemonConfig, '../bad')).throw();
  });
});

describe('session-id parsing', () => {
  it.each(['a', 'session-1', 'session.one_two', `a${'b'.repeat(127)}`])('should accept %s', input => {
    // Act
    const actual = tryParseSessionId(input);

    // Assert
    should(actual).equal(input);
  });

  it('should reject traversal, case-colliding, control, unicode, and oversized values', () => {
    // Arrange
    const inputs = ['', '.', '-a', '..', 'A', 'Session', 'a/b', 'a\\b', 'é', 'a\0b', `a${'b'.repeat(128)}`];

    // Act + Assert
    for (const input of inputs) should(tryParseSessionId(input)).be.undefined();
  });
});

describe('layout decisions', () => {
  it.each([
    { marker: undefined, entries: [], expected: 'initialize' },
    {
      marker: undefined,
      entries: ['config', 'daemon.lock', 'fleet', 'state'],
      recoverable: true,
      expected: 'initialize',
    },
    { marker: `${CURRENT_LAYOUT_VERSION}\n`, entries: ['layout-version'], expected: 'proceed' },
    { marker: undefined, entries: ['config'], expected: 'refuse' },
    { marker: 'garbage', entries: ['layout-version'], expected: 'refuse' },
    { marker: '2', entries: ['layout-version'], expected: 'refuse' },
    { marker: '0', entries: ['layout-version'], expected: 'refuse' },
  ])('should choose $expected for marker $marker', ({ marker, entries, recoverable, expected }) => {
    // Act
    const actual = decideLayout(marker, entries, recoverable);

    // Assert
    should(actual.kind).equal(expected);
  });

  it.each([
    { found: 0, tables: false, shape: false, expected: 'create' },
    { found: 1, tables: true, shape: true, expected: 'use' },
    { found: 1, tables: true, shape: false, expected: 'drop-and-rebuild' },
    { found: 0, tables: true, shape: true, expected: 'drop-and-rebuild' },
    { found: 2, tables: true, shape: true, expected: 'drop-and-rebuild' },
  ])('should choose $expected for index generation $found', ({ found, tables, shape, expected }) => {
    // Act
    const actual = decideIndexSchema(found, tables, shape);

    // Assert
    should(actual).equal(expected);
  });

  it('should distinguish current and unsupported session markers', () => {
    // Act
    const current = decideSessionMarker('1\n');
    const missing = decideSessionMarker(undefined);
    const future = decideSessionMarker('2');

    // Assert
    should(current).equal('proceed');
    should(missing).equal('refuse');
    should(future).equal('refuse');
  });

  it('should describe missing and unsupported home markers distinctly', () => {
    // Arrange
    const paths = createFoundationPaths(resolveStateHome({ fyHome: '/tmp/fy-home', homeDirectory: '/unused' }));
    const missing = decideLayout(undefined, ['config']);
    const unsupported = decideLayout('2', ['layout-version']);
    if (missing.kind !== 'refuse' || unsupported.kind !== 'refuse') throw new Error('test decisions must refuse');

    // Act
    const missingError = new StateHomeLayoutError(paths, missing);
    const unsupportedError = new StateHomeLayoutError(paths, unsupported);

    // Assert
    should(missingError.message).equal('state home /tmp/fy-home is non-empty but has no layout-version marker');
    should(unsupportedError.message).equal('state home /tmp/fy-home has layout version "2"; expected 1');
  });
});
