/**
 * `kernel.updateHost` on the real machine (today's update module: `HostInstallFacts` seams and `CliUpdateLauncher`).
 * The launch is the one command, detached and unreferenced in its own process group, so nothing that signals the
 * daemon's group reaches the update and it outlives the daemon's restart.
 */
import { closeSync, openSync } from 'node:fs';
import { mkdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type { ExecutableFacts, UpdateHostPort } from '../../contract/ports.ts';

/**
 * The client verb the launch runs, today's `daemon update` (`update-files.ts` CliUpdateLauncher). One constant, so
 * the 5.0 verb the Updates plugin declares is a one-line change.
 */
export const UPDATE_LAUNCH_VERB: readonly string[] = Object.freeze(['daemon', 'update']);

/** A release number as GitHub tags it: `5.1.0`, `v5.1.0`, `5.1.0-rc.1`. */
const RELEASE = /^v?[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}(?:-[0-9A-Za-z.]{1,40})?$/u;

/** Starts a detached child with all three streams on `logFile` (appended, 0600). A suite watches the call instead. */
export type DetachedUpdateSpawn = (
  argv: readonly string[],
  options: { readonly environment: Readonly<Record<string, string | undefined>>; readonly logFile: string },
) => void;

function spawnDetached(
  argv: readonly string[],
  options: { readonly environment: Readonly<Record<string, string | undefined>>; readonly logFile: string },
): void {
  const log = openSync(options.logFile, 'a', 0o600);
  try {
    Bun.spawn([...argv], {
      stdin: 'ignore',
      stdout: log,
      stderr: log,
      env: { ...options.environment },
      // Its own process group, so nothing that signals the daemon's group reaches the update.
      detached: true,
    }).unref();
  } finally {
    // The child holds its own copy of the descriptor; the daemon's is not needed past the spawn.
    closeSync(log);
  }
}

export interface UpdateHostOptions {
  readonly home: string;
  /** The client's binary name (single-sourced, `fy`): it sits beside the daemon's executable. */
  readonly binary: string;
  readonly release: string;
  readonly process?: Pick<ExecutableFacts, 'argv0' | 'execPath' | 'main' | 'workingDirectory' | 'platform'>;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly spawn?: DetachedUpdateSpawn;
  readonly resolveLink?: (path: string) => Promise<string>;
}

/** The port for one plugin: its report and log live in its own state folder. */
export function updateHostFor(options: UpdateHostOptions): (plugin: string) => UpdateHostPort {
  const facts = options.process ?? {
    argv0: process.argv0,
    execPath: process.execPath,
    main: Bun.main,
    workingDirectory: process.cwd(),
    platform: process.platform,
  };
  const spawn = options.spawn ?? spawnDetached;
  const resolveLink = options.resolveLink ?? (async (path: string) => await realpath(path));
  return plugin => {
    const directory = join(options.home, 'state', plugin);
    const port: UpdateHostPort = {
      release: options.release,
      compiled: facts.main.startsWith('/$bunfs/'),
      executable: async () => ({
        ...facts,
        resolvedExecPath: await resolveLink(facts.execPath).catch(() => facts.execPath),
      }),
      launchUpdate: async target => {
        if (!RELEASE.test(target)) return { kind: 'failed', reason: `${target} is not a release number` };
        // THE LAUNCHED PATH IS argv0 when absolute: the install's link, not the store path behind it.
        const launched = isAbsolute(facts.argv0) ? facts.argv0 : facts.execPath;
        const client = join(dirname(launched), options.binary);
        const report = join(directory, 'report.json');
        try {
          // today's ensureDirectory(dirname(report), 0o700)
          await mkdir(dirname(report), { recursive: true, mode: 0o700 });
          spawn([client, ...UPDATE_LAUNCH_VERB, '--yes', '--to', target, '--report', report], {
            environment: { ...(options.environment ?? process.env), FY_HOME: options.home },
            logFile: join(directory, 'update.log'),
          });
          return { kind: 'started' };
        } catch (error) {
          return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) };
        }
      },
    };
    return Object.freeze(port);
  };
}

/** What a plugin without `permissions.updateHost` (or a host without the adapter) holds: facts refuse, launches fail. */
export function undeclaredUpdateHost(plugin: string, release: string): UpdateHostPort {
  const why = `${plugin} did not declare permissions.updateHost.`;
  return Object.freeze({
    release,
    compiled: false,
    executable: async () => {
      throw new Error(why);
    },
    launchUpdate: async () => ({ kind: 'failed' as const, reason: why }),
  });
}
