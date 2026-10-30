#!/usr/bin/env bun
/**
 * Finds, names, kills and reports every PROCESS a test run left behind — not only tmux servers.
 *
 * WHY. A test run that ends with a child still running is a run that did not end: a daemon a fixture
 * forgot, a Chrome a timed-out test never closed, a `sleep` a harness stand-in started. Left alone it
 * holds ports, files and CPU into the next run, and a runner that waits on it hangs instead of failing.
 * `tmux-sweep.ts` already does this for tmux servers; this does it for everything else.
 *
 * HOW A PROCESS IS KNOWN TO BE THIS RUN'S. `scripts/test/swept.sh` points `TMPDIR` at a root this run
 * alone owns, and every child a test spawns inherits it. So a process whose environment carries
 * `TMPDIR=<root>` belongs to this run, whatever its parent became after a double fork. That is read
 * from `/proc/<pid>/environ`, which only Linux has; elsewhere the sweep says it is skipping and passes.
 *
 * A GRACE, NOT A RACE. Some programs end a moment after their parent (Chrome's crash handler). A
 * process is reported only if it is still running after {@link GRACE_MS}; then it is sent SIGTERM, and
 * SIGKILL if it outlives that too.
 *
 * Usage: `leak-sweep.ts [--fail-on-leak] [--exit-status <status>] <root>` — prints one line per process
 * it kills, exits 1 with `--fail-on-leak` when it killed any and the command itself had passed.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { deathSignal } from './tmux-sweep.ts';

/** How long a straggler may take to end on its own before it counts as leaked. */
const GRACE_MS = 5_000;
/** How long SIGTERM is given before SIGKILL. */
const TERM_MS = 2_000;
const POLL_MS = 100;

export interface LeakedProcess {
  readonly pid: number;
  readonly args: string;
}

type Reader = (path: string) => string | undefined;

const read: Reader = path => {
  try {
    return readFileSync(path, 'latin1');
  } catch {
    return undefined;
  }
};

/** The processes whose environment names `root` as their TMPDIR, this process and its ancestors excepted. */
export function processesUnder(root: string, ancestors: ReadonlySet<number>, readProc: Reader = read): LeakedProcess[] {
  const marker = `TMPDIR=${root}`;
  const found: LeakedProcess[] = [];
  for (const entry of readdirSync('/proc')) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || ancestors.has(pid)) continue;
    const environ = readProc(`/proc/${pid}/environ`);
    if (environ === undefined || !environ.split('\0').includes(marker)) continue;
    const args = (readProc(`/proc/${pid}/cmdline`) ?? '').split('\0').filter(Boolean).join(' ');
    found.push({ pid, args: args === '' ? '(no command line)' : args });
  }
  return found;
}

/** This process and every ancestor: the sweep, `swept.sh` and whatever started it. */
function ancestorsOfSelf(readProc: Reader = read): Set<number> {
  const seen = new Set<number>();
  let pid = process.pid;
  while (pid > 1 && !seen.has(pid)) {
    seen.add(pid);
    const status = readProc(`/proc/${pid}/status`);
    const parent = /^PPid:\s+(\d+)/mu.exec(status ?? '')?.[1];
    if (parent === undefined) break;
    pid = Number(parent);
  }
  return seen;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const settle = async (pids: readonly number[], withinMs: number) => {
  for (let waited = 0; waited < withinMs && pids.some(alive); waited += POLL_MS) await Bun.sleep(POLL_MS);
};

const signal = (pids: readonly number[], name: 'SIGTERM' | 'SIGKILL') => {
  for (const pid of pids.filter(alive)) {
    try {
      process.kill(pid, name);
    } catch {
      // Gone between the check and the signal: what was wanted.
    }
  }
};

async function main(args: readonly string[]): Promise<number> {
  const failOnLeak = args.includes('--fail-on-leak');
  const statusAt = args.indexOf('--exit-status');
  const exitStatus = statusAt === -1 ? undefined : Number(args[statusAt + 1]);
  const roots = args.filter(
    (arg, index) => arg !== '--fail-on-leak' && index !== statusAt && (statusAt === -1 || index !== statusAt + 1),
  );
  const root = roots[0];
  if (roots.length !== 1 || root === undefined) {
    console.error('usage: leak-sweep.ts [--fail-on-leak] [--exit-status <status>] <root>');
    return 2;
  }
  // Only ever a run root swept.sh made: a marker that matched a shared TMPDIR could name a sibling's work.
  if (!/^\/(private\/)?tmp\/fyt\.[A-Za-z0-9]+$|^\/.+\/fyt\.[A-Za-z0-9]+$/u.test(root)) {
    console.error(`❌ ${root} is not a run root made by swept.sh — nothing was killed`);
    return 2;
  }
  if (!existsSync('/proc/self/environ')) {
    console.error(`⏭️  process leak sweep skipped: no /proc on ${process.platform} (tmux-sweep.ts still ran)`);
    return 0;
  }
  let leaked = processesUnder(root, ancestorsOfSelf());
  if (leaked.length === 0) return 0;
  await settle(
    leaked.map(row => row.pid),
    GRACE_MS,
  );
  leaked = leaked.filter(row => alive(row.pid));
  if (leaked.length === 0) return 0;
  const pids = leaked.map(row => row.pid);
  signal(pids, 'SIGTERM');
  await settle(pids, TERM_MS);
  signal(pids, 'SIGKILL');
  for (const row of leaked) console.error(`🧹 killed leaked process ${String(row.pid)}: ${row.args.slice(0, 300)}`);
  const died = exitStatus === undefined ? undefined : deathSignal(exitStatus);
  if (died !== undefined) {
    console.error(
      `⚠️ the test process died on ${died} before its fixtures could tear down, so these are the crash's leftovers — read the crash above; this is not a fixture leak`,
    );
    return 0;
  }
  if (!failOnLeak) return 0;
  console.error(
    `❌ the test run left ${String(leaked.length)} process(es) running; every fixture must end what it starts (afterAll / finally)`,
  );
  return 1;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
