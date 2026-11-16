import { describe, it } from 'bun:test';
import should from 'should';
import {
  launchdThrottled,
  livenessOf,
  parseLaunchdPrint,
  parseSystemdProperties,
  readLaunchdReport,
  readSystemdReport,
  servesOutsideSupervisor,
} from '../../src/lib/daemon/probe.ts';
import {
  beginReadinessWait,
  decideReadiness,
  decideShutdown,
  defaultReadinessPolicy,
  defaultShutdownPolicy,
} from '../../src/lib/daemon/readiness.ts';

describe('what systemd and launchd say about the daemon', () => {
  it('reads a systemd property whole, even when its value holds an equals sign', () => {
    should(parseSystemdProperties('LoadState=loaded\nActiveState=active\nMainPID=4321\nnoise\n=x\nNote=a=b')).deepEqual(
      {
        loadState: 'loaded',
        activeState: 'active',
        mainPid: 4321,
      },
    );
    should(parseSystemdProperties('MainPID=1')).deepEqual({});
  });

  it('says no unit is installed when systemd has not found one, or knows nothing and no definition is on disk', () => {
    const absent = { manager: 'systemd', state: 'absent', detail: 'no systemd user unit is installed' };
    should(readSystemdReport({ loadState: 'not-found', activeState: 'inactive' }, true)).deepEqual(absent);
    should(readSystemdReport({}, false)).deepEqual(absent);
  });

  it('reads systemd’s active, failed and stopped states, and names the pid only when it knows it', () => {
    should(readSystemdReport({ activeState: 'activating', mainPid: 7 }, true)).deepEqual({
      manager: 'systemd',
      state: 'running',
      pid: 7,
      detail: 'systemd reports activating',
    });
    should(readSystemdReport({ activeState: 'active' }, true)).deepEqual({
      manager: 'systemd',
      state: 'running',
      detail: 'systemd reports active',
    });
    should(readSystemdReport({ activeState: 'failed' }, true).state).equal('failed');
    should(readSystemdReport({ activeState: 'inactive' }, true).state).equal('stopped');
    should(readSystemdReport({}, true)).deepEqual({
      manager: 'systemd',
      state: 'stopped',
      detail: 'systemd reports nothing',
    });
  });

  it('reads a launchd job: running with its pid, failed with its exit status, absent, or stopped', () => {
    const print = parseLaunchdPrint('  state = running\n  pid = 4321\n  last exit status = 0');
    should(print).deepEqual({ state: 'running', pid: 4321, lastExitStatus: 0 });
    should(readLaunchdReport(print, true)).deepEqual({
      manager: 'launchd',
      state: 'running',
      pid: 4321,
      detail: 'launchd reports running',
    });
    should(readLaunchdReport({ state: 'running' }, true)).deepEqual({
      manager: 'launchd',
      state: 'running',
      detail: 'launchd reports running',
    });
    should(readLaunchdReport({ state: 'waiting', lastExitStatus: 78 }, true)).deepEqual({
      manager: 'launchd',
      state: 'failed',
      detail: 'launchd reports waiting; last exit status 78',
    });
    should(readLaunchdReport({}, false)).deepEqual({
      manager: 'launchd',
      state: 'absent',
      detail: 'no launchd user agent is installed',
    });
    should(readLaunchdReport({}, true)).deepEqual({
      manager: 'launchd',
      state: 'stopped',
      detail: 'launchd reports nothing',
    });
  });

  it('turns a supervisor verdict into what a readiness wait should believe', () => {
    should(livenessOf({ manager: 'systemd', state: 'running', detail: '' })).equal('alive');
    should(livenessOf({ manager: 'systemd', state: 'failed', detail: '' })).equal('dead');
    should(livenessOf({ manager: 'systemd', state: 'stopped', detail: '' })).equal('absent');
    should(livenessOf({ manager: 'launchd', state: 'absent', detail: '' })).equal('absent');
  });

  it('knows a daemon its manager did not start: another pid, or a manager that is not running it', () => {
    const health = { protocol: 1, version: '5.0.0', pid: 10 };
    should(servesOutsideSupervisor({ manager: 'systemd', state: 'running', pid: 10, detail: '' }, health)).equal(false);
    should(servesOutsideSupervisor({ manager: 'systemd', state: 'running', pid: 11, detail: '' }, health)).equal(true);
    should(servesOutsideSupervisor({ manager: 'systemd', state: 'running', detail: '' }, health)).equal(false);
    should(servesOutsideSupervisor({ manager: 'systemd', state: 'failed', detail: '' }, health)).equal(true);
    should(servesOutsideSupervisor({ manager: 'direct', state: 'stopped', detail: '' }, health)).equal(false);
    should(servesOutsideSupervisor({ manager: 'systemd', state: 'stopped', detail: '' }, undefined)).equal(false);
  });

  it('calls launchd throttling only when a plist that was read names another process type', () => {
    const report = { manager: 'launchd', state: 'running', detail: '' } as const;
    should(launchdThrottled(report)).equal(false);
    should(launchdThrottled({ ...report, processType: 'Interactive' })).equal(false);
    should(launchdThrottled({ ...report, processType: 'Background' })).equal(true);
  });
});

describe('how long the daemon is given to come up and to go down', () => {
  const policy = defaultReadinessPolicy();

  it('fast-fails on a dead verdict only after the process was seen alive in this wait', () => {
    const started = beginReadinessWait(1_000);
    should(decideReadiness(started, 'dead', 1_100, policy)).deepEqual({
      kind: 'continue',
      state: { startedAtMs: 1_000, sawAlive: false, progressNoted: false },
    });
    const alive = decideReadiness(started, 'alive', 1_100, policy);
    if (alive.kind !== 'continue') throw new Error('expected to keep waiting');
    should(alive.state.sawAlive).equal(true);
    should(decideReadiness(alive.state, 'dead', 1_200, policy)).deepEqual({ kind: 'exited' });
  });

  it('gives up at the deadline, and notes progress once after ten seconds', () => {
    const started = beginReadinessWait(0);
    should(decideReadiness(started, 'alive', 90_000, policy)).deepEqual({ kind: 'timeout' });
    const noted = decideReadiness(started, 'alive', 10_400, policy);
    should(noted).deepEqual({
      kind: 'progress',
      elapsedSeconds: 10,
      state: { startedAtMs: 0, sawAlive: true, progressNoted: true },
    });
    if (noted.kind !== 'progress') throw new Error('expected a progress note');
    should(decideReadiness(noted.state, 'alive', 20_000, policy).kind).equal('continue');
  });

  it('keeps pressing a stop: wait, escalate once past ten seconds, give up at twenty', () => {
    const shutdown = defaultShutdownPolicy();
    should(decideShutdown(0, false, shutdown)).equal('wait');
    should(decideShutdown(10_000, false, shutdown)).equal('escalate');
    should(decideShutdown(10_000, true, shutdown)).equal('wait');
    should(decideShutdown(20_000, true, shutdown)).equal('give-up');
    should(decideShutdown(20_000, false, shutdown)).equal('give-up');
  });
});
