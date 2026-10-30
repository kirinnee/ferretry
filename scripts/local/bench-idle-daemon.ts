/**
 * What an IDLE daemon costs on a fleet the size of the owner's Mac — for any build, so a PR can put a
 * before and an after side by side.
 *
 * The fleet is `scaledFleet` (36 sessions, 5 running, three 200 MB Claude transcripts, 2,000 Codex
 * rollouts, six runtime homes, two Claude logins and one Codex login in Ferretry's own store on a 10 s usage
 * interval — their free usage reads answered by a loopback fake server), built once and copied fresh for every run, with a REAL tmux pane on the
 * daemon's private socket for each running session — without panes, every tmux question fails at once
 * and the child-process cost the Mac pays never shows. Nobody touches the daemon: it boots, its
 * housekeeping settles, and then it is measured twice, from outside and from inside:
 *
 *   1. its own `fy daemon profile` report, when the build serves `/v1/diagnostics/profile`;
 *   2. `/proc/<pid>/stat` for CPU, its children's included, over a second window of the same length;
 *   3. with `--trace`, `sudo strace -f` over a third window: file system calls by path shape and the
 *      programs started by program and subcommand (strace slows the daemon, so it gets its own window);
 *   4. with `--syscall-summary`, `sudo strace -f -c` over a fourth: every kind of system call, counted.
 *
 * With `--statusline`, one Claude login (`claude-work`) gets a fresh `usage.json` every 6 s for the
 * whole run, as `fy statusline` writes it while a session on that login runs — so the bench shows what a
 * passive update costs, and that a login with a running session is never given an active read.
 *
 * Manual only, never CI (the CI budget is `tests/realworld/runtime/idle-budget.test.ts`). Linux only.
 *
 *   bun scripts/local/bench-idle-daemon.ts [--fyd "<command>"] [--seconds 30] [--settle 40] [--trace]
 *     [--fixture /tmp/fy-idle-fixture] [--small] [--statusline] [--out report.json]
 *
 * `--fyd` defaults to this checkout's `bun packages/daemon/bin/fyd.ts`; pass an installed or compiled
 * `fyd` to measure a release. `--small` builds 8 MiB transcripts instead of 200 MB ones.
 */
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { PerformanceProfileView, PerformanceReport } from '../../packages/protocol/src/lib/index.ts';
import { parseStraceTrace } from '../../packages/cli/src/lib/daemon/profile/syscall-trace.ts';
import { FilePassiveUsageStore } from '../../packages/fleet/src/adapters/anthropic-usage-probe.ts';
import { renderPerformanceReport } from '../../packages/protocol/src/lib/performance-render.ts';
import { freeLoopbackPort } from '../../packages/daemon/tests/integration/support/booted-daemon.ts';
import { startFakeUsageServer } from '../../packages/daemon/tests/integration/support/fake-usage-server.ts';
import {
  OWNER_MAC_FLEET,
  scaledFleet,
  sessionIdOf,
} from '../../packages/daemon/tests/integration/support/scaled-fleet.ts';

const root = resolve(import.meta.dir, '../..');
const { values } = parseArgs({
  options: {
    fyd: { type: 'string' },
    seconds: { type: 'string', default: '30' },
    settle: { type: 'string', default: '40' },
    trace: { type: 'boolean', default: false },
    'syscall-summary': { type: 'boolean', default: false },
    fixture: { type: 'string', default: '/tmp/fy-idle-fixture' },
    small: { type: 'boolean', default: false },
    statusline: { type: 'boolean', default: false },
    out: { type: 'string' },
  },
});
const seconds = Number(values.seconds);
const settle = Number(values.settle);
const fyd = values.fyd?.split(' ') ?? [process.execPath, join(root, 'packages/daemon/bin/fyd.ts')];
const shape = {
  ...OWNER_MAC_FLEET,
  running: 5,
  ...(values.small ? { hugeTranscriptBytes: 8 * 1024 * 1024, transcriptBytes: 2 * 1024 * 1024 } : {}),
};

const log = (line: string): void => {
  process.stderr.write(`[bench] ${line}\n`);
};

log(`fixture: ${values.fixture} (${String(shape.sessions)} sessions, ${String(shape.running)} running)`);
const fixture = await scaledFleet(values.fixture, shape);
const run = `${values.fixture}-run-${String(process.pid)}`;
await rm(run, { recursive: true, force: true });
await mkdir(run, { recursive: true });
log('copying the fixture for this run');
await cp(fixture.home, join(run, 'home'), { recursive: true });
await cp(fixture.userHome, join(run, 'user'), { recursive: true });
const home = join(run, 'home');
const userHome = join(run, 'user');
const port = await freeLoopbackPort();
await mkdir(join(home, 'config'), { recursive: true });
await writeFile(
  join(home, 'config', 'daemon.json'),
  JSON.stringify({ host: '127.0.0.1', port, relay: { url: 'ws://127.0.0.1:9', enabled: false } }),
);

// A real pane for every running session, on the daemon's own private socket.
const socket = join(home, 'tmux.sock');
const tmux = (args: readonly string[]) => Bun.spawnSync(['tmux', '-u', '-S', socket, ...args]);
for (let index = 0; index < shape.running; index += 1) {
  const config = JSON.parse(
    await readFile(join(home, 'state', 'sessions', sessionIdOf(index), 'config.json'), 'utf8'),
  ) as { tmuxSession: string };
  const made = tmux(['new-session', '-d', '-s', config.tmuxSession, '-x', '200', '-y', '50', 'sleep 86400']);
  if (made.exitCode !== 0) throw new Error(`tmux new-session failed: ${made.stderr.toString()}`);
}

// The fixture's logins are real stores, so the usage pass makes its free reads: here, never at a provider.
const usage = startFakeUsageServer();
// A running session's statusLine on one login: a temporary file, then a rename, every 6 s.
const statusLineFile = new FilePassiveUsageStore(join(home, 'fleet')).path('claude-work');
const writeStatusLine = async (): Promise<void> => {
  const temporary = `${statusLineFile}.${String(process.pid)}.tmp`;
  await writeFile(
    temporary,
    JSON.stringify({ version: 1, source: 'claude-statusline', at: Date.now(), fiveHour: { usedPercent: 12 } }),
  );
  await rename(temporary, statusLineFile);
};
if (values.statusline) await writeStatusLine();
const statusLineTicks = values.statusline ? setInterval(() => void writeStatusLine(), 6_000) : undefined;
log(`starting ${fyd.join(' ')}`);
const daemon = Bun.spawn([...fyd], {
  env: {
    ...process.env,
    FY_HOME: home,
    HOME: userHome,
    FYD_BACKGROUND_DELAY_SECONDS: '5',
    FY_USAGE_PROBE_ORIGIN: usage.origin,
  },
  stdin: 'ignore',
  stdout: Bun.file(join(run, 'fyd.out')),
  stderr: Bun.file(join(run, 'fyd.err')),
});
const base = `http://127.0.0.1:${String(port)}`;
let report: PerformanceReport | undefined;
let external: { cpuPercent: number; childrenPercent: number } | undefined;
let trace: ReturnType<typeof parseStraceTrace> | undefined;
let syscallSummary: string | undefined;
try {
  for (let attempt = 0; ; attempt += 1) {
    if ((await fetch(`${base}/healthz`).catch(() => undefined))?.ok === true) break;
    if (attempt > 1_200) throw new Error(`the daemon never answered: ${await readFile(join(run, 'fyd.err'), 'utf8')}`);
    await Bun.sleep(100);
  }
  const pid = daemon.pid;
  log(`serving (pid ${String(pid)}); letting it settle for ${String(settle)} s`);
  await Bun.sleep(settle * 1_000);
  const token = (await readFile(join(home, 'api-token'), 'utf8')).trim();
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  // 1. The daemon's own report.
  const started = await fetch(`${base}/v1/diagnostics/profile`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ seconds }),
  });
  if (started.status === 202) {
    const view = (await started.json()) as PerformanceProfileView;
    log(`profiling from inside for ${String(seconds)} s`);
    await Bun.sleep(seconds * 1_000 + 500);
    for (let attempt = 0; attempt < 60 && report === undefined; attempt += 1) {
      const read = (await (
        await fetch(`${base}/v1/diagnostics/profile/${view.id}`, { headers })
      ).json()) as PerformanceProfileView;
      if (read.state === 'finished') report = read.report;
      else await Bun.sleep(1_000);
    }
  } else log(`this build has no profile route (HTTP ${String(started.status)}); measuring from outside only`);

  // 2. CPU from outside, children included.
  const ticks = async (): Promise<{ self: number; children: number }> => {
    const text = await readFile(`/proc/${String(pid)}/stat`, 'utf8');
    const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
    return { self: Number(fields[11]) + Number(fields[12]), children: Number(fields[13]) + Number(fields[14]) };
  };
  log(`measuring CPU from outside for ${String(seconds)} s`);
  const before = await ticks();
  await Bun.sleep(seconds * 1_000);
  const after = await ticks();
  external = {
    cpuPercent: Math.round(((after.self - before.self) / seconds) * 10) / 10,
    childrenPercent: Math.round(((after.children - before.children) / seconds) * 10) / 10,
  };

  // 3. System calls and programs started, under strace.
  if (values.trace) {
    const file = join(run, 'strace.txt');
    log(`tracing for ${String(seconds)} s (sudo strace)`);
    const tracer = Bun.spawn(
      ['sudo', '-n', 'strace', '-f', '-qq', '-s', '256', '-e', 'trace=%file,execve', '-o', file, '-p', String(pid)],
      { stdout: 'ignore', stderr: 'pipe' },
    );
    await Bun.sleep(seconds * 1_000);
    Bun.spawnSync(['sudo', '-n', 'kill', '-INT', String(tracer.pid)]);
    await tracer.exited;
    trace = parseStraceTrace(await readFile(file, 'utf8').catch(() => ''), seconds, {
      home: userHome,
      stateHome: home,
    });
  }

  // 4. Every kind of system call, counted.
  if (values['syscall-summary']) {
    const file = join(run, 'strace-summary.txt');
    log(`counting every system call for ${String(seconds)} s (sudo strace -c)`);
    const tracer = Bun.spawn(['sudo', '-n', 'strace', '-f', '-c', '-o', file, '-p', String(pid)], {
      stdout: 'ignore',
      stderr: 'pipe',
    });
    await Bun.sleep(seconds * 1_000);
    Bun.spawnSync(['sudo', '-n', 'kill', '-INT', String(tracer.pid)]);
    await tracer.exited;
    syscallSummary = await readFile(file, 'utf8').catch(() => '');
  }
} finally {
  if (statusLineTicks !== undefined) clearInterval(statusLineTicks);
  daemon.kill();
  await daemon.exited;
  tmux(['kill-server']);
  await usage.stop();
}

const usageReads = Object.fromEntries(usage.hits);
const summary = { fyd: fyd.join(' '), shape, seconds, external, trace, syscallSummary, usageReads, report };
if (values.out !== undefined) await writeFile(values.out, `${JSON.stringify(summary, null, 2)}\n`);
await rm(run, { recursive: true, force: true });

const lines: string[] = [];
lines.push(`fyd: ${fyd.join(' ')}`);
lines.push(
  `free usage reads (whole run): ${
    Object.entries(usageReads)
      .map(([path, count]) => `${path} ${String(count)}`)
      .join(' · ') || 'none'
  }`,
);
if (external !== undefined)
  lines.push(
    `outside: daemon ${String(external.cpuPercent)}% of a core · reaped children ${String(external.childrenPercent)}%`,
  );
if (trace !== undefined) {
  lines.push(`strace: ${trace.total.toLocaleString('en-US')} file calls+execs (${String(trace.perSecond)}/s)`);
  const execs = trace.executions.reduce((sum, entry) => sum + entry.count, 0);
  lines.push(`  programs started: ${String(execs)} (${String(Math.round((execs / seconds) * 60))}/min)`);
  for (const entry of trace.executions.slice(0, 10))
    lines.push(`    ${String(Math.round((entry.count / seconds) * 60)).padStart(6)}/min  ${entry.command}`);
  lines.push('  top file calls:');
  for (const entry of trace.top.slice(0, 20))
    lines.push(`    ${String(entry.perSecond).padStart(8)}/s  ${entry.call} ${entry.path}`);
}
if (syscallSummary !== undefined)
  lines.push('', `strace -c (${String(seconds)} s):`, ...syscallSummary.split('\n').slice(0, 30));
if (report !== undefined) lines.push('', renderPerformanceReport(report));
process.stdout.write(`${lines.join('\n')}\n`);
