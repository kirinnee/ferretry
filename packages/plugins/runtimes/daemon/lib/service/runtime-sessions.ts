/**
 * The sessions a runtime removal or rename reaches, and what a rename does to their records.
 *
 * A session record names its runtime by NAME (`config.agent`) and by the wrapper it launched
 * (`config.command[0]`, an absolute path under the fleet's `bin`), and much of the daemon matches one
 * or the other exactly: the launch environment, credential renewal, model switching, the usage row and
 * every surface's label. A rename therefore re-points both on every record that names the old runtime,
 * so each of those keeps matching; `ids.json` keeps the old name resolving for anything that still
 * says it (a record that could not be rewritten, a script, a habit).
 *
 * Pure: the records are read and written by the caller.
 */
import type { HarnessKind } from '@ferretry/fleet';
import type { FleetRunningSession, SessionStatus } from '@ferretry/protocol';

/** A session as a runtime change needs to know it. */
export interface RuntimeSessionRecord {
  readonly id: string;
  /** What the person calls it: its teammate name, else its own name, else its id. */
  readonly name: string;
  readonly harness: HarnessKind;
  /** `config.agent`: the runtime name it launched as (or, in an old record, the wrapper path). */
  readonly agent: string;
  /** `config.command[0]`: the wrapper it launched, when the record has one. */
  readonly executable?: string;
  readonly status: SessionStatus;
}

/** Every spelling a runtime is known by, as a session record may carry it. */
export interface RuntimeSpellings {
  readonly name: string;
  /** Its wrapper's absolute path. */
  readonly wrapper: string;
  readonly id?: string;
  readonly formerNames?: readonly string[];
}

/** Whether a session record names this runtime, by any spelling it is known by. */
export function sessionRunsOn(record: RuntimeSessionRecord, runtime: RuntimeSpellings): boolean {
  const spellings = new Set([runtime.name, runtime.wrapper, ...(runtime.formerNames ?? [])]);
  if (runtime.id !== undefined) spellings.add(runtime.id);
  return spellings.has(record.agent) || (record.executable !== undefined && record.executable === runtime.wrapper);
}

/**
 * Whether a session with this status is still running, keyed exhaustively so a new status cannot fall
 * silently into either answer. A session that has ended — or whose kill failed and is being reaped —
 * has nothing a removal could leave behind.
 */
const SESSION_RUNNING: { readonly [K in SessionStatus]: boolean } = {
  created: true,
  starting: true,
  running: true,
  thinking: true,
  tool_running: true,
  awaiting_question: true,
  awaiting_user: true,
  interrupted: true,
  rate_limited: true,
  retrying: true,
  waiting: true,
  kill_failed: false,
  completed: false,
  failed: false,
  stalled: false,
  stopped: false,
};

/** Whether a session with this status is still running. */
export const sessionRunning = (status: SessionStatus): boolean => SESSION_RUNNING[status];

/** The running sessions on one runtime, as a confirm card lists them: by name, then id. */
export function runningSessionsOn(
  records: readonly RuntimeSessionRecord[],
  runtime: RuntimeSpellings,
): readonly FleetRunningSession[] {
  return records
    .filter(record => sessionRunning(record.status) && sessionRunsOn(record, runtime))
    .map(record => ({ id: record.id, name: record.name, harness: record.harness }))
    .toSorted((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

/** A rename as a session record sees it: the two names and the two wrappers. */
export interface SessionRuntimeRename {
  readonly from: string;
  readonly to: string;
  readonly fromWrapper: string;
  readonly toWrapper: string;
}

/**
 * A session's configuration document re-pointed from the old runtime to the new one, or `undefined`
 * when it does not name the old one. `agent` keeps its form — a name stays a name, a wrapper path
 * becomes the new wrapper path — and only `command[0]` moves in the argv, because the rest of it is
 * what the session was launched with and still is.
 */
export function renamedSessionConfig(
  current: unknown,
  rename: SessionRuntimeRename,
): Record<string, unknown> | undefined {
  if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined;
  const document = current as Readonly<Record<string, unknown>>;
  const agent =
    document.agent === rename.from ? rename.to : document.agent === rename.fromWrapper ? rename.toWrapper : undefined;
  const command = Array.isArray(document.command) ? document.command : undefined;
  const movesCommand = command?.[0] === rename.fromWrapper;
  if (agent === undefined && !movesCommand) return undefined;
  return {
    ...document,
    ...(agent === undefined ? {} : { agent }),
    ...(movesCommand && command !== undefined ? { command: [rename.toWrapper, ...command.slice(1)] } : {}),
  };
}
