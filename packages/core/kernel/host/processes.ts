/**
 * `kernel.processes` (§7.7): today's Codex app-server stopper's process rules
 * (`daemon/src/adapters/process/codex-app-server-stopper.ts` and the supervisor that decides over it), held by the
 * kernel so a plugin can neither widen them nor read what they read:
 *
 * - The plugin asks with pids and with folders of its OWN roots, and is answered with pids and booleans. The table
 *   below reads `environ` and `cmdline`; neither text ever leaves this module.
 * - `usersOf` matches only a variable the manifest lists in `permissions.processes.environment` (exact plain names;
 *   `'*'` is not a name, so it grants nothing), and only the value `<the folder's path>`: never free text, so no caller
 *   can ask which process carries a guessed credential.
 * - Only this user's processes (the table's rule), never pid 0 or 1, the daemon or one of its ancestors.
 * - SIGTERM only (the table has no other signal), and only to a process whose command line, read again at the moment
 *   of the signal, still starts with the folder's path plus `/` (today's `isCodexAppServerProcess` prefix rule).
 *
 * Pure but for the {@link ProcessTable} and the {@link OwnFolderSpellings}, which the real host answers from the disk
 * (`./adapters/process-table.ts`, `./roots.ts`) and the testing host from its own world: the same function decides
 * for both.
 */
import type { OwnFolder, ProcessesPort, ProcessSignalOutcome, RootName } from '../contract/ports.ts';
import type { ProcessesPermission } from '../manifest/types.ts';
import { PermissionError } from './permissions.ts';

/** The highest pid any supported platform hands out (Linux's `pid_max` ceiling, 2^22). */
const MAX_PID = 4_194_304;

/** One plain environment variable name. */
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;

/**
 * The host's view of this user's process table. Kernel-only: no plugin holds one. Every answer is about the daemon's
 * own uid; a process of another user is answered as absent.
 */
export interface ProcessTable {
  /** The daemon's own pid and every ancestor's it can find: never signalled, never said to run from anywhere. */
  protectedPids(): Promise<ReadonlySet<number>>;
  /** The command line of a live process of this user (arguments joined by one space), or `undefined`. */
  commandLine(pid: number): Promise<string | undefined>;
  /**
   * The pids of this user's live processes whose environment holds one of `entries` (each `NAME=value`) exactly, or
   * `undefined` when the table cannot be listed.
   */
  withEnvironment(entries: readonly string[]): Promise<readonly number[] | undefined>;
  /** SIGTERM one pid (no other signal exists here): `gone` when it had already exited, `refused` when not allowed. */
  sigterm(pid: number): Promise<ProcessSignalOutcome>;
}

/** A host with no process table wired: nothing can be listed, nothing runs from anywhere, nothing is signalled. */
export const NO_PROCESS_TABLE: ProcessTable = Object.freeze({
  protectedPids: async () => {
    throw new Error('this host has no process table');
  },
  commandLine: async () => undefined,
  withEnvironment: async () => undefined,
  sigterm: async (): Promise<ProcessSignalOutcome> => 'refused',
});

/** The roots whose folders `kernel.processes` accepts: the ones the kernel bases itself, never a caller-scoped owner root. */
export const PROCESS_FOLDER_ROOTS: ReadonlySet<RootName> = new Set<RootName>(['fleet', 'agent-homes']);

/**
 * Whether a folder, named relative to its root, is one `kernel.processes` accepts. The `fleet` root takes only a folder
 * at or under `homes/<id>` (today's stopper matched only inside one `fleet/homes/<id>`); `agent-homes` takes any.
 */
export const processFolderAllowed = (root: RootName, relative: string): boolean => {
  if (root !== 'fleet') return true;
  const parts = relative.split('/').filter(part => part !== '');
  return parts.length >= 2 && parts[0] === 'homes';
};

/**
 * Every spelling of an {@link OwnFolder} the kernel accepts (its real path, and the path as the root names it), or
 * `undefined` when `folder.root` is not a handle the kernel made for `plugin`. A path the root refuses throws the
 * root's own refusal.
 */
export type OwnFolderSpellings = (plugin: string, folder: OwnFolder) => Promise<readonly string[] | undefined>;

/** Whether `pid` is a whole number the kernel will ask about at all. */
const isAskablePid = (pid: unknown): pid is number =>
  Number.isSafeInteger(pid) && (pid as number) > 1 && (pid as number) <= MAX_PID;

const trimSlash = (path: string): string => (path.length > 1 ? path.replace(/\/+$/u, '') : path);

/** Today's prefix rule: the command line, leading space dropped, starts with one spelling plus `/`. */
export const runsBeneath = (commandLine: string, spellings: readonly string[]): boolean =>
  spellings.some(spelling => spelling !== '/' && commandLine.trimStart().startsWith(`${trimSlash(spelling)}/`));

/** The variable names a permission lists that this port will match: plain names only. */
export const matchableVariables = (permission: ProcessesPermission | undefined): ReadonlySet<string> =>
  new Set(
    (Array.isArray(permission?.environment) ? permission.environment : []).filter(
      (name): name is string => typeof name === 'string' && VARIABLE_NAME.test(name),
    ),
  );

/** What a plugin without `permissions.processes` holds: every member refuses, naming it. */
function undeclaredProcesses(plugin: string): ProcessesPort {
  const refuse = async (): Promise<never> => {
    throw new PermissionError(`${plugin} did not declare permissions.processes, so it asks about no process.`);
  };
  return Object.freeze({ runsFrom: refuse, usersOf: refuse, terminate: refuse });
}

/** `kernel.processes` for one plugin, over the host's table and the host's own-root check. */
export function processesPortFor(
  plugin: string,
  permission: ProcessesPermission | undefined,
  spellingsOf: OwnFolderSpellings,
  table: ProcessTable,
): ProcessesPort {
  if (permission === undefined) return undeclaredProcesses(plugin);
  const variables = matchableVariables(permission);
  const own = async (folder: OwnFolder): Promise<readonly string[]> => {
    const spellings = folder === null || typeof folder !== 'object' ? undefined : await spellingsOf(plugin, folder);
    if (spellings === undefined || spellings.length === 0)
      throw new PermissionError(`${plugin} may ask about processes only with a folder of one of its own roots.`);
    return spellings;
  };
  /**
   * Where `pid` stands against the folder right now: `absent` when it is not one of this user's live processes,
   * `refused` when it is one the kernel never signals or one that does not run from beneath the folder.
   */
  const standing = async (pid: number, spellings: readonly string[]): Promise<'runs' | 'absent' | 'refused'> => {
    if (!isAskablePid(pid)) return 'refused';
    // Which pids are the daemon's own line, unknown: nothing is signalled (fail closed).
    const guarded = await table.protectedPids().catch(() => undefined);
    if (guarded === undefined || guarded.has(pid)) return 'refused';
    const commandLine = await table.commandLine(pid).catch(() => undefined);
    if (commandLine === undefined) return 'absent';
    return runsBeneath(commandLine, spellings) ? 'runs' : 'refused';
  };
  return Object.freeze({
    runsFrom: async (pid: number, under: OwnFolder) => (await standing(pid, await own(under))) === 'runs',
    usersOf: async (variable: string, value: OwnFolder) => {
      if (typeof variable !== 'string' || !variables.has(variable))
        throw new PermissionError(
          `${plugin} may match only the environment variables its permissions.processes lists, and not this one.`,
        );
      const spellings = await own(value);
      const found = await table
        .withEnvironment(spellings.map(spelling => `${variable}=${spelling}`))
        .catch(() => undefined);
      // Pids only, each once, in order: nothing else about a process is said.
      return found === undefined ? undefined : [...new Set(found.filter(isAskablePid))].sort((a, b) => a - b);
    },
    terminate: async (pid: number, under: OwnFolder): Promise<ProcessSignalOutcome> => {
      const spellings = await own(under);
      // Read again right before the signal: a pid file's claim, or a pid reused since the last look, is not enough.
      const now = await standing(pid, spellings);
      if (now !== 'runs') return now === 'absent' ? 'gone' : 'refused';
      return await table.sigterm(pid).catch((): ProcessSignalOutcome => 'refused');
    },
  });
}
