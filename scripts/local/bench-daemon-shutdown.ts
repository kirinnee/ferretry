/**
 * How long a daemon takes to stop, and what its WebRTC engine costs while nobody uses it — for any build,
 * so a PR can put a before and an after side by side.
 *
 * Each run boots `fyd` over a fresh, empty state home on loopback (no relay, no ICE server, so nothing
 * leaves the machine), waits until it serves, reads its threads and RSS from `/proc`, and then sends
 * SIGTERM and times the exit. With `--peer`, a paired device first opens a direct session, signals a
 * WebRTC offer inside it (`docs/relay-protocol.md` §16) and keeps a real libdatachannel peer CONNECTED —
 * with its session channel open — while the daemon is told to stop, which is the case a phone on
 * WebRTC puts a daemon in when it is restarted for an update.
 *
 * A run that has not exited within `--deadline` seconds is a HANG: its threads' kernel wait channels
 * (and, when `gdb` is on PATH, every thread's stack) are written beside the report, and it is killed.
 *
 * Manual only, never CI (the realworld-tier check is `tests/realworld/runtime/shutdown-time.test.ts`). Linux only.
 *
 *   bun scripts/local/bench-daemon-shutdown.ts --fyd "<command>" [--runs 50] [--peer] [--fleet] [--deadline 20]
 *     [--settle 1] [--out report.json]
 */
import { readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { dialWebRtc, type WebRtcPhone } from '../../packages/daemon/tests/integration/support/webrtc-phone.ts';
import { buildWorld } from '../../packages/daemon/bin/fyd.ts';
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
    runs: { type: 'string', default: '50' },
    peer: { type: 'boolean', default: false },
    deadline: { type: 'string', default: '20' },
    settle: { type: 'string', default: '1' },
    fleet: { type: 'boolean', default: false },
    out: { type: 'string' },
  },
});
const runs = Number(values.runs);
const deadlineMs = Number(values.deadline) * 1_000;
const settleMs = Number(values.settle) * 1_000;
const fyd = values.fyd?.split(' ') ?? [process.execPath, join(root, 'packages/daemon/bin/fyd.ts')];

const log = (line: string): void => {
  process.stderr.write(`[shutdown-bench] ${line}\n`);
};

interface ThreadCensus {
  readonly total: number;
  readonly rtc: number;
  readonly sctp: number;
  readonly rssMiB: number;
}

/** Every thread of `pid` by name, and its resident set — what `ls /proc/<pid>/task/*\/comm` shows. */
async function census(pid: number): Promise<ThreadCensus> {
  const tasks = await readdir(`/proc/${String(pid)}/task`);
  const names = await Promise.all(
    tasks.map(async task => (await readFile(`/proc/${String(pid)}/task/${task}/comm`, 'utf8').catch(() => '')).trim()),
  );
  const status = await readFile(`/proc/${String(pid)}/status`, 'utf8');
  const rssKiB = Number(/VmRSS:\s+(\d+)/u.exec(status)?.[1] ?? 0);
  return {
    total: names.length,
    rtc: names.filter(name => name.startsWith('RTC')).length,
    sctp: names.filter(name => name.startsWith('SCTP')).length,
    rssMiB: Math.round((rssKiB / 1024) * 10) / 10,
  };
}

/** What a hung daemon's threads are waiting in — the evidence that names the culprit. */
async function hangEvidence(pid: number, file: string): Promise<void> {
  const tasks = await readdir(`/proc/${String(pid)}/task`).catch(() => [] as string[]);
  const lines = await Promise.all(
    tasks.map(async task => {
      const at = `/proc/${String(pid)}/task/${task}`;
      const comm = (await readFile(`${at}/comm`, 'utf8').catch(() => '?')).trim();
      const wchan = (await readFile(`${at}/wchan`, 'utf8').catch(() => '?')).trim();
      return `${task}\t${comm}\t${wchan}`;
    }),
  );
  // A daemon is not this bench's child's child, so Yama's default ptrace scope refuses a plain attach:
  // with passwordless sudo the stacks are read as root, and without it the wait channels above must do.
  const gdb = Bun.which('gdb');
  const sudo = Bun.spawnSync(['sudo', '-n', 'true']).exitCode === 0;
  const stacks =
    gdb === null
      ? 'gdb is not on PATH; no native stacks'
      : Bun.spawnSync(
          [...(sudo ? ['sudo', '-n'] : []), gdb, '-p', String(pid), '-batch', '-ex', 'thread apply all bt'],
          {
            stdout: 'pipe',
            stderr: 'pipe',
          },
        ).stdout.toString();
  await writeFile(file, `${lines.join('\n')}\n\n${stacks}\n`);
}

/** The boot trail's `webrtc` step, in milliseconds: its own `+Nms` less the previous line's. */
function webrtcStepOf(trail: string): number {
  const stamps = trail
    .split('\n')
    .map(line => ({ line, at: Number(/ \+(\d+)ms /u.exec(line)?.[1] ?? Number.NaN) }))
    .filter(entry => !Number.isNaN(entry.at));
  const index = stamps.findIndex(entry => / webrtc — /u.test(entry.line));
  return index > 0 ? (stamps[index]?.at ?? 0) - (stamps[index - 1]?.at ?? 0) : Number.NaN;
}
interface RunReport {
  readonly bootMs: number;
  /** What the boot trail's `webrtc` step took: from the step before it to its own line. */
  readonly webrtcStepMs: number;
  readonly idle: ThreadCensus;
  readonly connected?: ThreadCensus;
  readonly offerMs?: number;
  readonly openMs?: number;
  readonly exitMs: number;
  readonly hung: boolean;
  readonly exitCode: number | null;
}

const scratch = await mkdtemp(join(tmpdir(), 'fy-shutdown-bench-'));
/**
 * With `--fleet`, the owner-scale fleet `bench-idle-daemon.ts` measures (small transcripts), so the
 * daemon stops with its session workers, housekeeping and usage reads alive — the state the one
 * observed hang was in. Built once; every run gets a fresh copy.
 */
const fleetShape = {
  ...OWNER_MAC_FLEET,
  running: 5,
  hugeTranscriptBytes: 8 * 1024 * 1024,
  transcriptBytes: 2 * 1024 * 1024,
};
const fleet = values.fleet ? await scaledFleet(join(scratch, 'fixture'), fleetShape) : undefined;
const usage = fleet === undefined ? undefined : startFakeUsageServer();

/** A state home for one run, and the user home beside it. */
async function prepareHome(run: string): Promise<{ readonly home: string; readonly userHome: string }> {
  const home = join(run, 'home');
  const userHome = join(run, 'user');
  if (fleet !== undefined) {
    await cp(fleet.home, home, { recursive: true });
    await cp(fleet.userHome, userHome, { recursive: true });
    await mkdir(join(home, 'config'), { recursive: true });
    return { home, userHome };
  }
  await mkdir(userHome, { recursive: true });
  // A state home the daemon recognises as its own, made by its own storage — an empty directory with a
  // config file in it is a home it refuses to adopt.
  process.env.FY_HOME = home;
  await (await buildWorld({}, { userHome }).storage.open()).storage.close();
  delete process.env.FY_HOME;
  await mkdir(join(home, 'config'), { recursive: true });
  return { home, userHome };
}

/** A real pane for every running session of the fleet, on the daemon's own private socket. */
function startPanes(home: string): { stop: () => void } {
  const socket = join(home, 'tmux.sock');
  const tmux = (args: readonly string[]) => Bun.spawnSync(['tmux', '-u', '-S', socket, ...args]);
  for (let index = 0; index < fleetShape.running; index += 1) {
    const config = JSON.parse(
      readFileSync(join(home, 'state', 'sessions', sessionIdOf(index), 'config.json'), 'utf8'),
    ) as { tmuxSession: string };
    const made = tmux(['new-session', '-d', '-s', config.tmuxSession, '-x', '200', '-y', '50', 'sleep 86400']);
    if (made.exitCode !== 0) throw new Error(`tmux new-session failed: ${made.stderr.toString()}`);
  }
  return { stop: () => void tmux(['kill-server']) };
}

const reports: RunReport[] = [];
log(`${String(runs)} runs of ${fyd.join(' ')}${values.peer ? ' with a connected WebRTC peer' : ''}`);
for (let index = 0; index < runs; index += 1) {
  const run = join(scratch, `run-${String(index)}`);
  const { home, userHome } = await prepareHome(run);
  const port = await freeLoopbackPort();
  await writeFile(
    join(home, 'config', 'daemon.json'),
    JSON.stringify({
      host: '127.0.0.1',
      port,
      relay: { url: 'ws://127.0.0.1:9', enabled: false },
      webrtc: { iceServers: [] },
    }),
  );
  const panes = fleet === undefined ? undefined : startPanes(home);
  const spawned = performance.now();
  const daemon = Bun.spawn([...fyd], {
    env: {
      ...process.env,
      FY_HOME: home,
      HOME: userHome,
      ...(usage === undefined ? {} : { FY_USAGE_PROBE_ORIGIN: usage.origin }),
    },
    stdin: 'ignore',
    stdout: Bun.file(join(run, 'fyd.out')),
    stderr: Bun.file(join(run, 'fyd.err')),
  });
  const base = `http://127.0.0.1:${String(port)}`;
  let peer: WebRtcPhone | undefined;
  try {
    // Boot is timed to `ready` — the last step of the boot trail — and not to `/healthz`, which answers
    // while the boot is still arming its loops (and before the SIGTERM handler exists).
    for (let attempt = 0; ; attempt += 1) {
      const trail = await readFile(join(run, 'fyd.err'), 'utf8').catch(() => '');
      if (/ ready — serving /u.test(trail)) break;
      if (attempt > 6_000) throw new Error(`the daemon never became ready: ${trail}`);
      await Bun.sleep(10);
    }
    const bootMs = performance.now() - spawned;
    await Bun.sleep(settleMs);
    const idle = await census(daemon.pid);
    peer = values.peer ? await dialWebRtc(base, home) : undefined;
    const connected = peer === undefined ? undefined : await census(daemon.pid);
    const signalled = performance.now();
    daemon.kill('SIGTERM');
    const outcome = await Promise.race([daemon.exited.then(() => 'exited' as const), Bun.sleep(deadlineMs)]);
    const hung = outcome !== 'exited';
    if (hung) {
      const file = join(scratch, `hang-${String(index)}.txt`);
      await hangEvidence(daemon.pid, file);
      log(`run ${String(index)} HUNG after SIGTERM; evidence in ${file}`);
      daemon.kill('SIGKILL');
      await daemon.exited;
    }
    const exitMs = performance.now() - signalled;
    const report: RunReport = {
      bootMs,
      webrtcStepMs: webrtcStepOf(await readFile(join(run, 'fyd.err'), 'utf8')),
      idle,
      ...(connected === undefined ? {} : { connected }),
      ...(peer === undefined ? {} : { offerMs: peer.offerMs, openMs: peer.openMs }),
      exitMs,
      hung,
      exitCode: daemon.exitCode,
    };
    reports.push(report);
    log(
      `run ${String(index)}: boot ${bootMs.toFixed(0)} ms · idle ${String(idle.total)} threads (${String(idle.rtc)} RTC, ${String(idle.sctp)} SCTP) ${String(idle.rssMiB)} MiB` +
        (peer === undefined ? '' : ` · offer ${peer.offerMs.toFixed(0)} ms, open ${peer.openMs.toFixed(0)} ms`) +
        ` · exit ${exitMs.toFixed(0)} ms${hung ? ' (HUNG)' : ''} code ${String(daemon.exitCode)}`,
    );
  } finally {
    peer?.close();
    panes?.stop();
    if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill('SIGKILL');
    await daemon.exited;
  }
  if (!reports.at(-1)?.hung) await rm(run, { recursive: true, force: true });
}

const quantile = (numbers: readonly number[], q: number): number => {
  const sorted = [...numbers].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? Number.NaN;
};
const describe = (label: string, numbers: readonly number[]): string =>
  numbers.length === 0
    ? `${label}: —`
    : `${label}: p50 ${quantile(numbers, 0.5).toFixed(0)} · p99 ${quantile(numbers, 0.99).toFixed(0)} · max ${Math.max(...numbers).toFixed(0)} ms`;
const mean = (numbers: readonly number[]): number => numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
const lines = [
  `fyd: ${fyd.join(' ')}${values.peer ? ' (a WebRTC peer connected at SIGTERM)' : ''}`,
  `runs: ${String(reports.length)} · hung: ${String(reports.filter(report => report.hung).length)} · non-zero exits: ${String(reports.filter(report => report.exitCode !== 0).length)}`,
  describe(
    'boot to ready',
    reports.map(report => report.bootMs),
  ),
  describe(
    'boot step "webrtc"',
    reports.map(report => report.webrtcStepMs),
  ),
  describe(
    'SIGTERM to exit',
    reports.map(report => report.exitMs),
  ),
  `idle: ${mean(reports.map(report => report.idle.total)).toFixed(1)} threads (${mean(reports.map(report => report.idle.rtc)).toFixed(1)} RTC, ${mean(reports.map(report => report.idle.sctp)).toFixed(1)} SCTP) · RSS ${mean(reports.map(report => report.idle.rssMiB)).toFixed(1)} MiB`,
];
const connected = reports.flatMap(report => (report.connected === undefined ? [] : [report.connected]));
if (connected.length > 0) {
  lines.push(
    `connected: ${mean(connected.map(entry => entry.total)).toFixed(1)} threads (${mean(connected.map(entry => entry.rtc)).toFixed(1)} RTC) · RSS ${mean(connected.map(entry => entry.rssMiB)).toFixed(1)} MiB`,
    describe(
      'offer answered',
      reports.flatMap(report => (report.offerMs === undefined ? [] : [report.offerMs])),
    ),
    describe(
      'offer to channel open',
      reports.flatMap(report => (report.openMs === undefined ? [] : [report.openMs])),
    ),
  );
}
if (values.out !== undefined)
  await writeFile(values.out, `${JSON.stringify({ fyd, peer: values.peer, reports }, null, 2)}\n`);
if (!reports.some(report => report.hung)) await rm(scratch, { recursive: true, force: true });
process.stdout.write(`${lines.join('\n')}\n`);
await usage?.stop();
process.exit(0);
