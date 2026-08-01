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

export function indexFiles(paths: FoundationPaths): readonly string[] {
  const directory = dirname(paths.sessionIndex);
  const name = basename(paths.sessionIndex);
  return [paths.sessionIndex, join(directory, `${name}-wal`), join(directory, `${name}-shm`)];
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
