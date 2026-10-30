#!/usr/bin/env bun
/**
 * Finds, kills and reports every tmux server a test run left behind under the run's own roots.
 *
 * WHY BY PROCESS AND NOT BY SOCKET. A leaked server outlives its socket file: a fixture that removes
 * its temporary root deletes `tmux.sock` while the server is still running, and from then on
 * `tmux -S <sock> kill-server` answers "No such file or directory" and the server — and any agent in
 * its panes — runs forever. On 2026-10-19 the dev box had 92 of them, some four days old, and three
 * ran the owner's REAL Claude Code. A tmux server keeps the argv of the client that started it, so
 * its `-S <socket>` names the root it belongs to whether or not the file still exists.
 *
 * ONLY UNDER THE ROOTS GIVEN. Several runs share one machine, so a sweep that killed every tmux
 * server under `/tmp` would end a sibling run's live journey. Every caller names the roots it owns.
 *
 * AND ONLY ROOTS THAT ARE DISPOSABLE. A root must lie strictly inside a system temporary directory (or
 * this process's own `TMPDIR`), and may not be, hold or lie inside a protected path: the inherited
 * `FY_HOME`, the socket `TMUX` names, the ones `scripts/test/swept.sh` recorded in
 * `FY_TEST_PROTECTED_PATHS`, and this account's default state home. Those name the live server every
 * agent on the machine runs under, and a suite is often started from inside one of those agents. A
 * refused root kills nothing and exits 2; a server on a protected socket is never swept under any root.
 *
 * Usage: `tmux-sweep.ts [--fail-on-leak] [--exit-status <status>] <root>...` — prints one line per server
 * it kills, exits 1 with `--fail-on-leak` when it killed any, and 0 otherwise. `--exit-status` is the
 * test command's own status: one that died on a signal is already red, and its leftovers are reported as
 * the crash's, not a fixture's.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { constants, homedir, tmpdir } from 'node:os';
import { basename, delimiter, isAbsolute, join, resolve, sep } from 'node:path';

export interface LeakedTmuxServer {
  readonly pid: number;
  readonly socket: string;
  readonly args: string;
}

interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly args: string;
}

const SOCKET_FLAG = /(?:^|\s)-S\s+(\S+)/u;

/** The system temporary roots a swept root must lie strictly inside. */
const TEMPORARY_BASES = ['/tmp', '/private/tmp', '/var/tmp', '/var/folders'] as const;

/** The product name, read from the root manifest rather than spelled: it names the default state home. */
function productName(): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(resolve(import.meta.dir, '../../package.json'), 'utf8')) as {
      readonly name?: unknown;
    };
    return typeof manifest.name === 'string' && manifest.name !== '' ? manifest.name : undefined;
  } catch {
    return undefined;
  }
}

type Environment = Readonly<Record<string, string | undefined>>;

/** Every home and socket no sweep may reach: what this run inherited, and the account's default home. */
export function protectedPaths(
  environment: Environment = process.env,
  userHome: string = process.env.FY_TEST_REAL_HOME ?? homedir(),
): readonly string[] {
  const recorded = (environment.FY_TEST_PROTECTED_PATHS ?? '').split(delimiter);
  const socket = environment.TMUX?.split(',', 1)[0];
  const product = productName();
  const fallback = product === undefined ? [] : [join(userHome, `.${product}`)];
  return [...new Set([...recorded, environment.FY_HOME ?? '', socket ?? '', ...fallback])].filter(isAbsolute);
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function inside(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/** Why `root` may not be swept, or `undefined` when it may. */
export function rootRefusal(
  root: string,
  guarded: readonly string[] = protectedPaths(),
  temporary: string = tmpdir(),
): string | undefined {
  if (!isAbsolute(root)) return `${JSON.stringify(root)} is not an absolute path`;
  const target = canonical(root);
  const scratch = canonical(temporary);
  const bases = [...TEMPORARY_BASES.map(canonical), ...(scratch === sep ? [] : [scratch])];
  if (!bases.some(base => base !== target && inside(base, target)))
    return `${target} is not inside a temporary directory`;
  const reached = guarded.map(canonical).find(path => inside(path, target) || inside(target, path));
  return reached === undefined ? undefined : `${target} is, holds or lies inside ${reached}`;
}

/** Thrown before a single process is signalled when any root is not disposable. */
export class UnsafeSweepRootError extends Error {}

function processTable(): readonly ProcessRow[] {
  const listed = Bun.spawnSync(['ps', '-A', '-ww', '-o', 'pid=', '-o', 'ppid=', '-o', 'args='], {
    stdout: 'pipe',
    stderr: 'ignore',
  });
  if (!listed.success) return [];
  return listed.stdout
    .toString()
    .split('\n')
    .map(line => /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map(match => ({ pid: Number(match[1]), ppid: Number(match[2]), args: match[3] ?? '' }));
}

/**
 * Every tmux process whose socket lies under one of `roots`. A socket path is compared both as
 * written and canonicalised, because `/tmp` is `/private/tmp` on macOS and a deleted root can no
 * longer be resolved at all.
 */
export function tmuxServersUnder(
  roots: readonly string[],
  guarded: readonly string[] = protectedPaths(),
): readonly LeakedTmuxServer[] {
  const refusals = roots.flatMap(root => {
    const refusal = rootRefusal(root, guarded);
    return refusal === undefined ? [] : [refusal];
  });
  if (refusals.length > 0) throw new UnsafeSweepRootError(`refusing to sweep: ${refusals.join('; ')}`);
  const shielded = guarded.flatMap(path => [resolve(path), canonical(path)]);
  const owned = roots
    .filter(root => root !== '' && resolve(root) !== sep)
    .flatMap(root => [resolve(root), canonical(root)]);
  if (owned.length === 0) return [];
  return processTable()
    .filter(row => row.pid !== process.pid && basename(row.args.split(/\s/u, 1)[0] ?? '') === 'tmux')
    .flatMap(row => {
      const socket = SOCKET_FLAG.exec(row.args)?.[1];
      if (socket === undefined) return [];
      const candidates = [resolve(socket), canonical(socket)];
      // Never a protected socket, whatever root it was reached under.
      if (shielded.some(path => candidates.some(candidate => inside(path, candidate)))) return [];
      return owned.some(root => candidates.some(candidate => inside(root, candidate)))
        ? [{ pid: row.pid, socket, args: row.args }]
        : [];
    });
}

function descendants(table: readonly ProcessRow[], pid: number): readonly number[] {
  const children = table.filter(row => row.ppid === pid).map(row => row.pid);
  return [...children, ...children.flatMap(child => descendants(table, child))];
}

function signal(pids: readonly number[], name: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, name);
    } catch {
      // Already gone.
    }
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kills every tmux server under `roots` and everything running in its panes, synchronously, so it is
 * safe from an `exit` handler. A pane's program is killed by pid as well as by the server's hangup,
 * because a harness that ignores SIGHUP is exactly the kind of process this exists to stop.
 */
export function sweepTmuxServers(
  roots: readonly string[],
  guarded: readonly string[] = protectedPaths(),
): readonly LeakedTmuxServer[] {
  const servers = tmuxServersUnder(roots, guarded);
  if (servers.length === 0) return servers;
  const table = processTable();
  const targets = [...new Set(servers.flatMap(server => [server.pid, ...descendants(table, server.pid)]))];
  signal(targets, 'SIGTERM');
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && targets.some(alive)) Bun.sleepSync(50);
  signal(targets.filter(alive), 'SIGKILL');
  return servers;
}

/** The signal a process that exited `status` died on, from a shell's `128 + n` convention; none for a normal exit. */
export function deathSignal(status: number): string | undefined {
  if (!Number.isInteger(status) || status <= 128 || status > 128 + 64) return undefined;
  const number = status - 128;
  const name = Object.entries(constants.signals).find(([, value]) => value === number)?.[0];
  return name ?? `signal ${String(number)}`;
}

/**
 * What the sweep says about the servers it killed. A run whose test process died on a signal — Bun
 * crashing, a SIGKILL — never reached its fixtures' teardown, so whatever tmux it left is the crash's
 * consequence, not a fixture that forgot to clean up: blaming a fixture there sent the reader hunting
 * a leak that did not exist, past the crash that did.
 */
export function sweepVerdict(
  swept: readonly LeakedTmuxServer[],
  { failOnLeak, exitStatus }: { readonly failOnLeak: boolean; readonly exitStatus?: number },
): { readonly lines: readonly string[]; readonly fail: boolean } {
  const lines = swept.map(server => `🧹 killed leaked tmux server ${String(server.pid)} on ${server.socket}`);
  if (swept.length === 0) return { lines, fail: false };
  const signal = exitStatus === undefined ? undefined : deathSignal(exitStatus);
  if (signal !== undefined) {
    return {
      lines: [
        ...lines,
        `⚠️ the test process died on ${signal} before its fixtures could tear down, so the sweep ended the ${String(swept.length)} tmux server(s) it left — read the crash above; this is not a fixture leak`,
      ],
      fail: false,
    };
  }
  if (!failOnLeak) return { lines, fail: false };
  return {
    lines: [
      ...lines,
      `❌ the test run left ${String(swept.length)} tmux server(s) running; every fixture must kill its own`,
    ],
    fail: true,
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const failOnLeak = args.includes('--fail-on-leak');
  const statusAt = args.indexOf('--exit-status');
  const exitStatus = statusAt === -1 ? undefined : Number(args[statusAt + 1]);
  const roots = args.filter(
    (arg, index) => arg !== '--fail-on-leak' && index !== statusAt && (statusAt === -1 || index !== statusAt + 1),
  );
  if (roots.length === 0) {
    console.error('usage: tmux-sweep.ts [--fail-on-leak] [--exit-status <status>] <root>...');
    process.exit(2);
  }
  let swept: readonly LeakedTmuxServer[];
  try {
    swept = sweepTmuxServers(roots);
  } catch (error) {
    if (!(error instanceof UnsafeSweepRootError)) throw error;
    console.error(`❌ ${error.message} — nothing was killed`);
    process.exit(2);
  }
  const verdict = sweepVerdict(swept, { failOnLeak, exitStatus });
  for (const line of verdict.lines) console.error(line);
  if (verdict.fail) process.exit(1);
}
