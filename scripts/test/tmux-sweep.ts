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
 * Usage: `tmux-sweep.ts [--fail-on-leak] <root>...` — prints one line per server it kills, exits 1
 * with `--fail-on-leak` when it killed any, and 0 otherwise.
 */
import { realpathSync } from 'node:fs';
import { basename, resolve, sep } from 'node:path';

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
export function tmuxServersUnder(roots: readonly string[]): readonly LeakedTmuxServer[] {
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
export function sweepTmuxServers(roots: readonly string[]): readonly LeakedTmuxServer[] {
  const servers = tmuxServersUnder(roots);
  if (servers.length === 0) return servers;
  const table = processTable();
  const targets = [...new Set(servers.flatMap(server => [server.pid, ...descendants(table, server.pid)]))];
  signal(targets, 'SIGTERM');
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && targets.some(alive)) Bun.sleepSync(50);
  signal(targets.filter(alive), 'SIGKILL');
  return servers;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const failOnLeak = args.includes('--fail-on-leak');
  const roots = args.filter(arg => arg !== '--fail-on-leak');
  if (roots.length === 0) {
    console.error('usage: tmux-sweep.ts [--fail-on-leak] <root>...');
    process.exit(2);
  }
  const swept = sweepTmuxServers(roots);
  for (const server of swept) console.error(`🧹 killed leaked tmux server ${String(server.pid)} on ${server.socket}`);
  if (swept.length > 0 && failOnLeak) {
    console.error(
      `❌ the test run left ${String(swept.length)} tmux server(s) running; every fixture must kill its own`,
    );
    process.exit(1);
  }
}
