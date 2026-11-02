import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { LAYOUT_VERSION_FILENAME } from '@ferretry/protocol';
import type { SessionId } from './session-id.ts';
import type { StateHome } from './state-home.ts';

export interface FoundationPaths {
  readonly home: StateHome;
  /**
   * The layout claim.
   *
   * The path is derived here, but the NAME is not ours alone: the command-line client writes this
   * same file when it creates a home, before this daemon has ever run. Both sides take the name from
   * `@ferretry/protocol` so a daemon cannot look for one file while its client writes another.
   */
  readonly layoutVersion: string;
  readonly daemonLock: string;
  readonly config: string;
  readonly daemonConfig: string;
  /** The operator's routing doctrine: which models exist and which accounts may serve them. */
  readonly routingCatalog: string;
  readonly fleet: string;
  readonly fleetManifest: string;
  /**
   * Where the daemon's own log is written, by whoever supervises it.
   *
   * Declared here even though nothing in this package writes to it. The CLI creates this directory
   * before it launches the daemon, so it is the ONE entry that can legitimately exist in an
   * otherwise-fresh state home — and a layout model that did not name it read our own log directory
   * as somebody else's data and refused to bootstrap any clean machine.
   */
  readonly logs: string;
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
  /**
   * The daemon's durable Ed25519 identity document, holding its PKCS#8 PEM.
   *
   * STATE, not config: pairing mints it on the first boot, an operator never writes it, and its
   * SHA-256 fingerprint is the `daemonId` in the pairing QR that every browser pins. Named here
   * because TWO subsystems now read it — pairing, which owns writing it, and the relay claim, which
   * must sign with the very same key or every paired browser computes a mismatch.
   */
  readonly daemonIdentity: string;
  /**
   * A RETIRED file: where the operator password's verifier used to live.
   *
   * The passkey step-up replaced that password, so nothing reads or writes this path any more. It is
   * named only so boot can delete a copy an older daemon left behind and say so once — a verifier for a
   * gate that no longer exists is a file somebody could mistake for one that still protects them.
   */
  readonly retiredOperatorPassword: string;
  /**
   * Where a change to the grants is written down, one JSON line per change.
   *
   * IN THE STATE HOME, so it is keyed by daemon by construction — a state home has exactly one owner,
   * and one daemon's record can therefore never be read as another's. It holds actors and axes, never
   * a token and never anything about the password.
   */
  readonly grantAudit: string;
  /** Who changed this machine's security settings, and every device key replaced (B6). */
  readonly securityAudit: string;
  /**
   * The catalogs this machine PUBLISHES: the document that lists them and the frozen item versions
   * beside it (docs/catalogs.md § The publisher side). STATE, never config: nobody hand-edits a
   * revision, and a damaged document is an error rather than an empty list.
   */
  readonly catalogs: string;
  readonly catalogsDocument: string;
  /** The version 1 document as it was when the upgrade to version 2 ran: how an older daemon is gone back to. */
  readonly catalogsBackupV1: string;
  readonly catalogsBackupV2: string;
  readonly catalogBlobs: string;
  /**
   * The people this machine shares catalogs with and the codes that let them in (docs/catalogs.md § Members).
   * STATE: a damaged file is an error, never an empty list. `catalogShares` holds the SHA-256 of each code and
   * never a code.
   */
  readonly catalogMembers: string;
  readonly catalogShares: string;
  /** The passkeys and unlocks of members' browsers, by member KEY id: public keys and instants, never a secret. */
  readonly catalogMemberPasskeys: string;
  readonly catalogMemberUnlocks: string;
}
export interface SessionPaths {
  readonly directory: string;
  readonly marker: string;
  readonly config: string;
  readonly state: string;
  readonly events: string;
  readonly lastSnapshot: string;
  readonly terminalPane: string;
  /**
   * Where the session's agent puts media it made to SHOW the person — a chart, a recording, a report.
   * Inside the daemon's own session state rather than the working tree, so a generated file never
   * dirties a repository and no repository's ignore rules decide whether it can be shown. Handed to
   * the pane as `FY_MEDIA_DIR` and read back by `/fs/file?scope=media` (docs/hypermedia.md).
   */
  readonly media: string;
  /**
   * Where Claude's `PreToolUse` hook records the `AskUserQuestion` it is asking — which its transcript
   * holds back until the form is answered (`lib/session/question/asked.ts`). Handed to the pane as
   * `FY_QUESTION_FILE`; replaced whole by every question, read by both observer hosts.
   */
  readonly questionAsked: string;
}

export function createFoundationPaths(home: StateHome): FoundationPaths {
  const config = join(home, 'config');
  const fleet = join(home, 'fleet');
  const state = join(home, 'state');
  const index = join(state, 'index');
  return {
    home,
    layoutVersion: join(home, LAYOUT_VERSION_FILENAME),
    daemonLock: join(home, 'daemon.lock'),
    config,
    daemonConfig: join(config, 'daemon.json'),
    routingCatalog: join(config, 'routing.json'),
    fleet,
    fleetManifest: join(fleet, 'manifest.json'),
    logs: join(home, 'logs'),
    state,
    index,
    sessionIndex: join(index, 'sessions.sqlite'),
    analyticsIndex: join(index, 'analytics.sqlite'),
    sessions: join(state, 'sessions'),
    temporary: join(state, 'tmp'),
    daemonIdentity: join(state, 'daemon-identity.json'),
    retiredOperatorPassword: join(state, 'operator-password.json'),
    grantAudit: join(state, 'grant-audit.jsonl'),
    securityAudit: join(state, 'security-audit.jsonl'),
    catalogs: join(state, 'catalogs'),
    catalogsDocument: join(state, 'catalogs', 'catalogs.json'),
    catalogsBackupV1: join(state, 'catalogs', 'catalogs.v1.json'),
    catalogsBackupV2: join(state, 'catalogs', 'catalogs.v2.json'),
    catalogBlobs: join(state, 'catalogs', 'blobs'),
    catalogMembers: join(state, 'catalogs', 'members.json'),
    catalogShares: join(state, 'catalogs', 'shares.json'),
    catalogMemberPasskeys: join(state, 'catalogs', 'member-passkeys.json'),
    catalogMemberUnlocks: join(state, 'catalogs', 'member-unlocks.json'),
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
    media: join(directory, 'media'),
    questionAsked: join(directory, 'question-asked.json'),
  };
}

export function requiredLayoutDirectories(paths: FoundationPaths): readonly string[] {
  return [paths.home, paths.config, paths.fleet, paths.logs, paths.state, paths.index, paths.sessions, paths.temporary];
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
