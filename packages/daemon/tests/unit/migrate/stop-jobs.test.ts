import { describe, it } from 'bun:test';
import should from 'should';
import type { InflightReport, ProcessInfo } from '../../../src/lib/migrate/inflight-report.ts';
import type { ProcRow } from '../../../src/lib/migrate/process-table.ts';
import {
  AgentJobStopper,
  jobProcesses,
  mayBeSameProcess,
  type StopSignal,
  sameProcess,
} from '../../../src/lib/migrate/stop-jobs.ts';

const CLI = 100;

const cli: ProcessInfo = {
  pid: CLI,
  ppid: 1,
  argv: 'claude',
  startedSecondsAgo: 900,
  verdict: 'safe_to_kill',
  known: { kind: 'harness' } as never,
};
const shell: ProcessInfo = {
  pid: 200,
  ppid: CLI,
  argv: 'bash -c bun run dev',
  startedSecondsAgo: 120,
  verdict: 'unknown',
  toolShell: 200,
};
const server: ProcessInfo = {
  pid: 201,
  ppid: 200,
  argv: 'bun run dev',
  startedSecondsAgo: 119,
  verdict: 'unknown',
  toolShell: 200,
};
const safeJob: ProcessInfo = {
  pid: 300,
  ppid: CLI,
  argv: 'bash -c sleep 5',
  startedSecondsAgo: 3,
  verdict: 'safe_to_kill',
  toolShell: 300,
};

const report = (processes: readonly ProcessInfo[]): InflightReport => ({
  status: 'rate_limited',
  turn: 3,
  empty: processes.length === 0,
  openTools: [],
  processes,
  codexBackgroundTerminals: 0,
  discrepancy: 0,
  blindSpots: [],
  worstVerdict: 'unknown',
});

describe('jobProcesses', () => {
  it('should take every process of a blocking job, deepest first, and never the CLI or a job that does not block', () => {
    // Act
    const pids = jobProcesses(report([cli, shell, server, safeJob])).map(process => process.pid);

    // Assert
    should(pids).deepEqual([201, 200]);
  });
});

const T0 = Date.parse('2026-11-01T12:00:00.000Z');

/** A process as the stopper's first look pins it: its start, from its age at `T0`. */
const seen = (process: ProcessInfo) => ({
  pid: process.pid,
  argv: process.argv,
  startedAt: T0 / 1000 - (process.startedSecondsAgo ?? 0),
});

/** A row read at `atMs` of a process that started `startedAt` (epoch seconds). */
const rowAt = (process: ProcessInfo, startedAt: number, atMs: number, changes: Partial<ProcRow> = {}): ProcRow => ({
  pid: process.pid,
  ppid: process.ppid ?? 1,
  startedSecondsAgo: Math.floor(atMs / 1000 - startedAt),
  argv: process.argv,
  ...changes,
});

describe('sameProcess and mayBeSameProcess', () => {
  it('should accept the same process read later, its age grown with the clock, wherever its parent is now', () => {
    // Arrange
    const first = seen(server);
    const later = T0 + 6_000;

    // Act
    const same = sameProcess(first, rowAt(server, first.startedAt, later), later);
    const reparented = sameProcess(first, rowAt(server, first.startedAt, later, { ppid: 1 }), later);

    // Assert
    should(same).be.true();
    should(reparented).be.true();
  });

  it('should refuse a pid reused after the first look, even for a job only a second old', () => {
    // Arrange: a one-second-old job, and the same pid running the same command, started three seconds later.
    const young = { ...server, startedSecondsAgo: 1 };
    const first = seen(young);
    const later = T0 + 4_000;
    const reused = rowAt(young, T0 / 1000 + 3, later);

    // Act
    const signal = sameProcess(first, reused, later);
    const alive = mayBeSameProcess(first, reused, later);

    // Assert
    should(reused.startedSecondsAgo).equal(1);
    should(signal).be.false();
    should(alive).be.false();
  });

  it('should signal only the same command line, while still counting a same-start process alive', () => {
    // Arrange
    const first = seen(server);

    // Act
    const other = sameProcess(first, rowAt(server, first.startedAt, T0, { argv: 'vim notes.md' }), T0);
    const otherAlive = mayBeSameProcess(first, rowAt(server, first.startedAt, T0, { argv: 'vim notes.md' }), T0);
    const unknownAge = mayBeSameProcess({ ...first, startedAt: undefined }, rowAt(server, 0, T0), T0);
    const unknownSignal = sameProcess({ ...first, startedAt: undefined }, rowAt(server, 0, T0), T0);

    // Assert
    should(other).be.false();
    should(otherAlive).be.true();
    should(unknownAge).be.true();
    should(unknownSignal).be.false();
  });
});

/** How a process answers a signal: gone on TERM, gone only on KILL, or never gone. */
type Behaviour = 'term' | 'kill' | 'never';

interface Running {
  readonly ppid: number;
  readonly startedAt: number;
  readonly argv: string;
}

/**
 * A host with a clock: the pane tree the first look sees at `T0`, then every process by pid as signals take effect
 * and time passes (each sleep moves the clock). A child whose shell dies is re-parented to init — out of the pane's
 * tree, still on the host. `reuse` replaces a pid, once the clock passes its time, by a new process with the SAME
 * command line, as a restarted job would.
 */
function host(
  processes: readonly ProcessInfo[],
  behaviour: Readonly<Record<number, Behaviour>>,
  options: {
    readonly unreadable?: boolean;
    readonly protectedPids?: readonly number[];
    readonly reuse?: { readonly pid: number; readonly afterMs: number };
  } = {},
) {
  let now = T0;
  const signals: [number, StopSignal][] = [];
  const running = new Map<number, Running>(
    processes.map(process => [
      process.pid,
      { ppid: process.ppid ?? 1, startedAt: T0 / 1000 - (process.startedSecondsAgo ?? 0), argv: process.argv },
    ]),
  );
  let reused = false;
  const service = new AgentJobStopper({
    inspect: async () => report(processes),
    lookup: async pids => {
      if (options.unreadable === true) throw new Error('ps failed');
      const reuse = options.reuse;
      if (reuse !== undefined && !reused && now >= T0 + reuse.afterMs) {
        const old = running.get(reuse.pid);
        if (old !== undefined) running.set(reuse.pid, { ...old, startedAt: (T0 + reuse.afterMs) / 1000 });
        reused = true;
      }
      const found = new Map<number, ProcRow>();
      for (const pid of pids) {
        const entry = running.get(pid);
        if (entry !== undefined)
          found.set(pid, {
            pid,
            ppid: entry.ppid,
            startedSecondsAgo: Math.floor(now / 1000 - entry.startedAt),
            argv: entry.argv,
          });
      }
      return found;
    },
    signal: (pid, signal) => {
      signals.push([pid, signal]);
      const answer = behaviour[pid] ?? 'term';
      if (answer === 'term' || (answer === 'kill' && signal === 'SIGKILL')) {
        running.delete(pid);
        for (const [child, entry] of running) if (entry.ppid === pid) running.set(child, { ...entry, ppid: 1 });
      }
      return true;
    },
    sleep: async ms => {
      now += ms;
    },
    nowMs: () => now,
    protectedPids: new Set(options.protectedPids ?? []),
  });
  return { service, signals, running };
}

describe('AgentJobStopper', () => {
  it('should do nothing when no job blocks', async () => {
    // Arrange
    const { service, signals } = host([cli, safeJob], {});

    // Act
    const result = await service.stop();

    // Assert
    should(result).deepEqual({ stopped: [], survivors: [] });
    should(signals).deepEqual([]);
  });

  it('should send SIGTERM children first and report the jobs stopped once they are gone', async () => {
    // Arrange
    const { service, signals } = host([cli, shell, server], {});

    // Act
    const result = await service.stop();

    // Assert
    should(signals).deepEqual([
      [201, 'SIGTERM'],
      [200, 'SIGTERM'],
    ]);
    should(result.stopped.map(job => job.pid)).deepEqual([200, 201]);
    should(result.survivors).deepEqual([]);
  });

  it('should follow a child that ignored SIGTERM out of the pane tree and SIGKILL it, never calling it stopped while it runs', async () => {
    // Arrange: the server traps TERM; its shell dies on TERM, so the server is re-parented to init.
    const { service, signals, running } = host([cli, shell, server], { 201: 'kill' });

    // Act
    const result = await service.stop();

    // Assert
    should(signals).deepEqual([
      [201, 'SIGTERM'],
      [200, 'SIGTERM'],
      [201, 'SIGKILL'],
    ]);
    should(running.has(201)).be.false();
    should(result.survivors).deepEqual([]);
  });

  it('should report a re-parented child that outlived SIGKILL as a survivor, not stopped', async () => {
    // Arrange
    const { service, running } = host([cli, shell, server], { 201: 'never' });

    // Act
    const result = await service.stop();

    // Assert
    should(running.get(201)?.ppid).equal(1);
    should(result.stopped).deepEqual([]);
    should(result.survivors.map(job => job.pid)).deepEqual([200, 201]);
  });

  it('should never signal a pid that now belongs to another process, and not count it as the job', async () => {
    // Arrange
    const { service, signals } = host([cli, shell, server], {}, { reuse: { pid: 201, afterMs: 0 } });

    // Act
    await service.stop();

    // Assert
    should(signals).deepEqual([[200, 'SIGTERM']]);
  });

  it('should not SIGKILL a young job’s pid once a restarted job with the same command took it', async () => {
    // Arrange: a one-second-old server that ignores SIGTERM; three seconds in, its pid is a new copy of it.
    const young = { ...server, startedSecondsAgo: 1 };
    const { service, signals } = host([cli, shell, young], { 201: 'kill' }, { reuse: { pid: 201, afterMs: 3_000 } });

    // Act
    await service.stop();

    // Assert
    should(signals).deepEqual([
      [201, 'SIGTERM'],
      [200, 'SIGTERM'],
    ]);
  });

  it('should never signal init, the daemon or its parent, and keep the job they are part of as a survivor', async () => {
    // Arrange: a tree that somehow lists the daemon under a job's shell.
    const daemon: ProcessInfo = { ...server, pid: 4000, argv: 'fyd' };
    const { service, signals } = host([cli, shell, daemon], {}, { protectedPids: [4000] });

    // Act
    const result = await service.stop();

    // Assert
    should(signals.map(([pid]) => pid)).not.containEql(4000);
    should(result.survivors.map(job => job.pid)).containEql(4000);
  });

  it('should stop nothing it cannot account for when the host cannot be read', async () => {
    // Arrange
    const { service, signals } = host([cli, shell, server], {}, { unreadable: true });

    // Act
    const result = await service.stop();

    // Assert
    should(signals).deepEqual([]);
    should(result.stopped).deepEqual([]);
    should(result.survivors.map(job => job.pid)).deepEqual([200, 201]);
  });
});
