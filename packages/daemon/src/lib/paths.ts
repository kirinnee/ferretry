import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import type { SessionId } from './session-id.ts';
import type { StateHome } from './state-home.ts';

export interface FoundationPaths {
  readonly home: StateHome;
  readonly layoutVersion: string;
  readonly daemonLock: string;
  readonly config: string;
  readonly daemonConfig: string;
  /** The operator's routing doctrine: which models exist and which accounts may serve them. */
  readonly routingCatalog: string;
  readonly fleet: string;
  readonly fleetManifest: string;
  readonly state: string;
  readonly index: string;
  readonly sessionIndex: string;
  /**
   * The analytics materialization: finished sessions, priced when they were ingested.
   *
   * A SEPARATE database from the session index, not another pair of tables in it. The two are dropped
   * for different reasons and on different schedules — a session index is rebuilt from journals when a
   * journal moves, and this one is rebuilt from session documents when a derivation changes — and the
   * session index refuses to open a file carrying tables it does not recognise, so an extra table in it
   * would make every daemon drop its whole event index on upgrade.
   */
  readonly analyticsIndex: string;
  readonly sessions: string;
  readonly temporary: string;
}
export interface SessionPaths {
  readonly directory: string;
  readonly marker: string;
  readonly config: string;
  readonly state: string;
  readonly events: string;
  readonly lastSnapshot: string;
  readonly terminalPane: string;
}

export function createFoundationPaths(home: StateHome): FoundationPaths {
  const config = join(home, 'config');
  const fleet = join(home, 'fleet');
  const state = join(home, 'state');
  const index = join(state, 'index');
  return {
    home,
    layoutVersion: join(home, 'layout-version'),
    daemonLock: join(home, 'daemon.lock'),
    config,
    daemonConfig: join(config, 'daemon.json'),
    routingCatalog: join(config, 'routing.json'),
    fleet,
    fleetManifest: join(fleet, 'manifest.json'),
    state,
    index,
    sessionIndex: join(index, 'sessions.sqlite'),
    analyticsIndex: join(index, 'analytics.sqlite'),
    sessions: join(state, 'sessions'),
    temporary: join(state, 'tmp'),
  };
}

export function createSessionPaths(paths: FoundationPaths, sessionId: SessionId): SessionPaths {
  const directory = join(paths.sessions, sessionId);
  return {
    directory,
    marker: join(directory, 'session-version'),
    config: join(directory, 'config.json'),
    state: join(directory, 'state.json'),
    events: join(directory, 'events.jsonl'),
    lastSnapshot: join(directory, 'last-snapshot.txt'),
    terminalPane: join(directory, 'terminal-pane.json'),
  };
}

export function requiredLayoutDirectories(paths: FoundationPaths): readonly string[] {
  return [paths.home, paths.config, paths.fleet, paths.state, paths.index, paths.sessions, paths.temporary];
}

/**
 * A SQLite database and the two sidecars the engine opens beside it.
 *
 * Named for every store rather than only the session index, because the sidecars are the reason this
 * function exists: the engine opens `-wal` and `-shm` by itself, outside any port, so every store that
 * wants its paths confined or its modes set has to enumerate all three.
 */
export function sqliteDatabaseFiles(database: string): readonly string[] {
  const directory = dirname(database);
  const name = basename(database);
  return [database, join(directory, `${name}-wal`), join(directory, `${name}-shm`)];
}

export function indexFiles(paths: FoundationPaths): readonly string[] {
  return sqliteDatabaseFiles(paths.sessionIndex);
}

export function analyticsIndexFiles(paths: FoundationPaths): readonly string[] {
  return sqliteDatabaseFiles(paths.analyticsIndex);
}

export function isPathInside(home: StateHome, candidate: string): boolean {
  if (!isAbsolute(candidate)) return false;
  const pathFromHome = relative(home, candidate);
  return pathFromHome === '' || (!pathFromHome.startsWith('..') && !isAbsolute(pathFromHome));
}

export function temporaryFilePath(paths: FoundationPaths, target: string, uniqueId: string): string {
  if (!isPathInside(paths.home, target)) throw new Error('atomic-write target is outside the state home');
  if (!/^[a-zA-Z0-9-]+$/.test(uniqueId)) throw new Error('temporary-file id is not path safe');
  return join(paths.temporary, `${basename(target)}.${uniqueId}.tmp`);
}
