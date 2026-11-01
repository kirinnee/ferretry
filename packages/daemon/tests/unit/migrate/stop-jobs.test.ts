import { describe, it } from 'bun:test';
import should from 'should';
import type { InflightReport, ProcessInfo } from '../../../src/lib/migrate/inflight-report.ts';
import { AgentJobStopper, jobProcesses, type StopSignal, sameProcess } from '../../../src/lib/migrate/stop-jobs.ts';

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

describe('sameProcess', () => {
  it('should accept the same process looked at again, a second younger by rounding', () => {
    // Act
    const same = sameProcess(server, { ...server, startedSecondsAgo: 125 });
    const rounded = sameProcess(server, { ...server, startedSecondsAgo: 118 });

    // Assert
    should(same).be.true();
    should(rounded).be.true();
  });

  it('should refuse a reused pid: a process started after the first look, or another command', () => {
    // Act
    const younger = sameProcess(server, { ...server, startedSecondsAgo: 2 });
    const other = sameProcess(server, { ...server, argv: 'vim notes.md' });
    const unparented = sameProcess(server, { ...server, toolShell: undefined });

    // Assert
    should(younger).be.false();
    should(other).be.false();
    should(unparented).be.false();
  });
});

function stopper(looks: readonly (readonly ProcessInfo[])[]) {
  const signals: [number, StopSignal][] = [];
  let look = 0;
  const service = new AgentJobStopper({
    inspect: async () => report(looks[Math.min(look++, looks.length - 1)] ?? []),
    signal: (pid, signal) => {
      signals.push([pid, signal]);
      return true;
    },
    sleep: async () => undefined,
  });
  return { service, signals };
}

describe('AgentJobStopper', () => {
  it('should do nothing when no job blocks', async () => {
    // Arrange
    const { service, signals } = stopper([[cli, safeJob]]);

    // Act
    const result = await service.stop();

    // Assert
    should(result).deepEqual({ stopped: [], survivors: [] });
    should(signals).deepEqual([]);
  });

  it('should send SIGTERM children first and report the jobs stopped once they are gone', async () => {
    // Arrange
    const { service, signals } = stopper([[cli, shell, server], [cli, shell, server], [cli]]);

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

  it('should SIGKILL only what is still the same process after the grace period', async () => {
    // Arrange
    const lingering = [cli, shell, server];
    const { service, signals } = stopper([lingering, lingering, ...Array(10).fill(lingering), [cli, server], [cli]]);

    // Act
    const result = await service.stop();

    // Assert
    should(signals.filter(([, signal]) => signal === 'SIGKILL')).deepEqual([[201, 'SIGKILL']]);
    should(result.survivors).deepEqual([]);
  });

  it('should never signal a pid that now belongs to another process', async () => {
    // Arrange
    const reused: ProcessInfo = { ...server, startedSecondsAgo: 0 };
    const { service, signals } = stopper([[cli, shell, server], [cli, shell, reused], [cli]]);

    // Act
    await service.stop();

    // Assert
    should(signals).deepEqual([[200, 'SIGTERM']]);
  });

  it('should report a job that outlived SIGKILL as a survivor', async () => {
    // Arrange
    const { service } = stopper([[cli, shell, server]]);

    // Act
    const result = await service.stop();

    // Assert
    should(result.stopped).deepEqual([]);
    should(result.survivors.map(job => job.pid)).deepEqual([200, 201]);
  });
});
