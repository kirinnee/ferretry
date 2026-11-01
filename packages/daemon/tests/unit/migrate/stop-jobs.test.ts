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

const row = (process: ProcessInfo, changes: Partial<ProcRow> = {}): ProcRow => ({
  pid: process.pid,
  ppid: process.ppid ?? 1,
  startedSecondsAgo: process.startedSecondsAgo ?? 0,
  argv: process.argv,
  ...changes,
});

describe('sameProcess and mayBeSameProcess', () => {
  it('should accept the same process looked at again, a second younger by rounding, wherever its parent is now', () => {
    // Act
    const same = sameProcess(server, row(server, { startedSecondsAgo: 125 }));
    const rounded = sameProcess(server, row(server, { startedSecondsAgo: 118 }));
    const reparented = sameProcess(server, row(server, { ppid: 1 }));

    // Assert
    should(same).be.true();
    should(rounded).be.true();
    should(reparented).be.true();
  });

  it('should refuse a reused pid, and signal only the same command line while still counting it alive', () => {
    // Act
    const younger = mayBeSameProcess(server, row(server, { startedSecondsAgo: 2 }));
    const other = sameProcess(server, row(server, { argv: 'vim notes.md' }));
    const otherAlive = mayBeSameProcess(server, row(server, { argv: 'vim notes.md' }));

    // Assert
    should(younger).be.false();
    should(other).be.false();
    should(otherAlive).be.true();
  });
});

/** How a process answers a signal: gone on TERM, gone only on KILL, or never gone. */
type Behaviour = 'term' | 'kill' | 'never';

/**
 * A host: the pane tree the first look sees, then every process by pid as signals take effect. A child whose shell
 * dies is re-parented to init — out of the pane's tree, still on the host.
 */
function host(
  processes: readonly ProcessInfo[],
  behaviour: Readonly<Record<number, Behaviour>>,
  options: { readonly unreadable?: boolean; readonly protectedPids?: readonly number[]; readonly reuse?: number } = {},
) {
  const signals: [number, StopSignal][] = [];
  const running = new Map(processes.map(process => [process.pid, row(process)]));
  const service = new AgentJobStopper({
    inspect: async () => report(processes),
    lookup: async pids => {
      if (options.unreadable === true) throw new Error('ps failed');
      const found = new Map<number, ProcRow>();
      for (const pid of pids) {
        const current = running.get(pid);
        // A reused pid is a process started after the first look: it has run for less time.
        if (current !== undefined)
          found.set(pid, pid === options.reuse ? { ...current, startedSecondsAgo: 0, argv: 'vim' } : current);
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
    sleep: async () => undefined,
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
    const { service, signals } = host([cli, shell, server], {}, { reuse: 201 });

    // Act
    await service.stop();

    // Assert
    should(signals).deepEqual([[200, 'SIGTERM']]);
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
