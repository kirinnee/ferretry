import { describe, it } from 'bun:test';
import type { HealthView } from '@ferretry/protocol';
import should from 'should';
import {
  DaemonController,
  type DaemonControllerDeps,
  DaemonShutdownFailedError,
  DaemonStartupFailedError,
} from '../../../src/lib/daemon/controller';
import type { DaemonSupervisorReport } from '../../../src/lib/daemon/ports';
import { UnsupportedServiceManagerError } from '../../../src/lib/daemon/supervisor';
import {
  absentReport,
  CapturedOutput,
  FakeHealth,
  FakeLogs,
  FakeSupervisor,
  failedReport,
  health,
  layout,
  runningReport,
  SteppingClock,
  stoppedReport,
} from './fixtures';

interface Harness {
  readonly controller: DaemonController;
  readonly out: CapturedOutput;
  readonly service: FakeSupervisor;
  readonly direct: FakeSupervisor;
  readonly logs: FakeLogs;
  readonly clock: SteppingClock;
}

function harness(options: {
  probes?: ReadonlyArray<HealthView | undefined>;
  serviceInstalled?: boolean;
  serviceReports?: DaemonSupervisorReport[];
  directReports?: DaemonSupervisorReport[];
  serviceFallback?: DaemonSupervisorReport;
  directFallback?: DaemonSupervisorReport;
  withoutService?: boolean;
  logs?: FakeLogs;
  step?: number;
  overrides?: Partial<DaemonControllerDeps>;
}): Harness {
  const service = new FakeSupervisor('systemd', options.serviceFallback ?? runningReport);
  service.installedAnswer = options.serviceInstalled ?? true;
  service.reports = options.serviceReports ?? [];
  const direct = new FakeSupervisor('direct', options.directFallback ?? absentReport);
  direct.installedAnswer = false;
  direct.reports = options.directReports ?? [];
  const out = new CapturedOutput();
  const logs = options.logs ?? new FakeLogs();
  const clock = new SteppingClock(options.step ?? 100);
  const controller = new DaemonController({
    layout: layout(),
    service: options.withoutService === true ? undefined : service,
    direct,
    health: new FakeHealth(options.probes ?? [health()]),
    logs,
    clock,
    out,
    readiness: { deadlineMs: 1_000, cadenceMs: 10, progressAfterMs: 300 },
    shutdown: { deadlineMs: 1_000, cadenceMs: 10, escalateAfterMs: 300 },
    ...options.overrides,
  });
  return { controller, out, service, direct, logs, clock };
}

describe('daemon install', () => {
  it('should install through the service manager and report the daemon it brought up', async () => {
    // Arrange
    const { controller, out, service } = harness({ probes: [undefined, health()] });

    // Act
    await controller.install();

    // Assert
    should(service.calls).containEql('install');
    should(out.text).containEql('fyd user service installed from');
    should(out.text).containEql('and started (pid 4242)');
  });

  it('should refuse on a host with no service manager instead of writing a Linux unit anyway', async () => {
    // Arrange
    const { controller } = harness({ withoutService: true });

    // Act + Assert
    await should(controller.install()).be.rejectedWith(UnsupportedServiceManagerError);
  });

  it('should report a daemon that installed but died during startup', async () => {
    // Arrange — the unit installs, systemd starts it, the process exits before serving.
    const { controller } = harness({
      probes: [undefined],
      serviceReports: [runningReport, failedReport],
      serviceFallback: failedReport,
    });

    // Act + Assert
    await should(controller.install()).be.rejectedWith(/exited during startup/u);
  });
});

describe('daemon uninstall', () => {
  it('should remove the definition through the service manager', async () => {
    // Arrange
    const { controller, out, service } = harness({});

    // Act
    await controller.uninstall();

    // Assert
    should(service.calls).containEql('uninstall');
    should(out.text).equal('ok: fyd user service removed');
  });

  it('should refuse where there is no service manager', async () => {
    // Arrange
    const { controller } = harness({ withoutService: true });

    // Act + Assert
    await should(controller.uninstall()).be.rejectedWith(/systemd user services on Linux/u);
  });
});

describe('daemon start', () => {
  it('should leave a healthy daemon alone rather than restarting it', async () => {
    // Arrange
    const { controller, out, service } = harness({ probes: [health()] });

    // Act
    await controller.start();

    // Assert — kteam's macOS start used `kickstart -k`, killing a working daemon every time.
    should(out.text).equal('ok: fyd is already serving (pid 4242)');
    should(service.calls).not.containEql('start');
  });

  it('should start through the installed service manager and wait until it serves', async () => {
    // Arrange
    const { controller, out, service } = harness({ probes: [undefined, undefined, health()] });

    // Act
    await controller.start();

    // Assert
    should(service.calls).containEql('start');
    should(out.text).equal('ok: fyd ready (pid 4242)');
  });

  it('should fall back to a direct launch when no service definition is installed', async () => {
    // Arrange
    const { controller, direct, service } = harness({
      probes: [undefined, health()],
      serviceInstalled: false,
    });

    // Act
    await controller.start();

    // Assert
    should(direct.calls).containEql('start');
    should(service.calls).not.containEql('start');
  });

  it('should note progress once when a slow boot passes the progress threshold', async () => {
    // Arrange — the clock advances 100ms per read, so the 300ms threshold arrives mid-wait.
    const { controller, out } = harness({
      probes: [undefined, undefined, undefined, undefined, health()],
      serviceFallback: runningReport,
    });

    // Act
    await controller.start();

    // Assert
    const progress = out.lines.filter(line => line.includes('still initializing'));
    should(progress).have.length(1);
    should(progress[0]).match(/waiting up to 1s…/u);
  });

  it('should give up with the log path when the daemon never serves', async () => {
    // Arrange
    const { controller } = harness({ probes: [undefined], serviceFallback: stoppedReport });

    // Act
    let caught: unknown;
    try {
      await controller.start();
    } catch (error) {
      caught = error;
    }

    // Assert
    should(caught).be.instanceof(DaemonStartupFailedError);
    should((caught as Error).message).match(/did not become ready within 1s; inspect .*logs\/fyd\.log/u);
  });
});

describe('daemon stop', () => {
  it('should say plainly when there is nothing to stop', async () => {
    // Arrange
    const { controller, out, service } = harness({ probes: [undefined], serviceFallback: stoppedReport });

    // Act
    await controller.stop();

    // Assert
    should(out.text).equal('warn: fyd is not running');
    should(service.stops).be.empty();
  });

  it('should stop a serving daemon and confirm it has actually gone', async () => {
    // Arrange
    const { controller, out, service } = harness({
      probes: [health(), undefined],
      serviceFallback: stoppedReport,
      serviceReports: [stoppedReport],
    });

    // Act
    await controller.stop();

    // Assert
    should(service.stops).deepEqual([{ pidHint: 4242, escalate: false }]);
    should(out.text).equal('ok: fyd stopped');
  });

  it('should stop a supervised daemon whose API is already unreachable', async () => {
    // Arrange
    const { controller, out, service } = harness({
      probes: [undefined],
      serviceReports: [runningReport, stoppedReport],
      serviceFallback: stoppedReport,
    });

    // Act
    await controller.stop();

    // Assert
    should(service.stops).deepEqual([{ pidHint: undefined, escalate: false }]);
    should(out.text).equal('ok: fyd stopped');
  });

  it('should escalate to an unconditional kill when a polite stop does not take', async () => {
    // Arrange — health keeps answering, so the daemon is refusing to go.
    const stubborn = harness({
      probes: [health()],
      serviceFallback: runningReport,
      step: 200,
    });

    // Act
    let caught: unknown;
    try {
      await stubborn.controller.stop();
    } catch (error) {
      caught = error;
    }

    // Assert
    should(caught).be.instanceof(DaemonShutdownFailedError);
    should(stubborn.service.stops.some(request => request.escalate)).be.true();
    should(stubborn.out.text).containEql('escalating to an unconditional kill');
  });

  it('should report the log path when the daemon will not stop at all', async () => {
    // Arrange
    const { controller } = harness({ probes: [health()], serviceFallback: runningReport, step: 600 });

    // Act + Assert
    await should(controller.stop()).be.rejectedWith(/did not stop within 1s; inspect .*logs\/fyd\.log/u);
  });
});

describe('daemon restart', () => {
  it('should wait for the old daemon to go quiet before starting the new one', async () => {
    // Arrange — a fixed 500ms sleep is what made kteam's successor die on EADDRINUSE.
    const { controller, out, service } = harness({
      probes: [health(), undefined, health()],
      serviceReports: [stoppedReport],
      serviceFallback: stoppedReport,
    });

    // Act
    await controller.restart();

    // Assert
    should(service.calls.indexOf('stop')).be.below(service.calls.indexOf('start'));
    should(out.text).endWith('ok: fyd restarted (pid 4242)');
  });

  it('should start a daemon that was not running, and say that is what happened', async () => {
    // Arrange
    const { controller, out, service } = harness({
      probes: [undefined, health()],
      serviceFallback: stoppedReport,
    });

    // Act
    await controller.restart();

    // Assert
    should(service.stops).be.empty();
    should(out.lines[0]).equal('warn: fyd was not running; starting it');
    should(out.text).containEql('ok: fyd restarted (pid 4242)');
  });
});

describe('daemon status', () => {
  it('should report a serving daemon as a human summary and succeed', async () => {
    // Arrange
    const { controller, out } = harness({ probes: [health()] });

    // Act
    await controller.status({});

    // Assert
    should(out.text).startWith('ok: fyd is serving');
    should(out.exitCode).be.undefined();
  });

  it('should fail when the daemon is stopped, so a script can branch on it', async () => {
    // Arrange
    const { controller, out } = harness({ probes: [undefined], serviceFallback: stoppedReport });

    // Act
    await controller.status({});

    // Assert
    should(out.text).startWith('warn: fyd is stopped');
    should(out.exitCode).equal(1);
  });

  it('should report a process that exists but does not answer', async () => {
    // Arrange
    const { controller, out } = harness({ probes: [undefined], serviceFallback: runningReport });

    // Act
    await controller.status({});

    // Assert
    should(out.text).containEql('process exists (pid 4242) but its API is unavailable');
    should(out.exitCode).equal(1);
  });

  it('should emit JSON on stdout even when the verdict is a failure', async () => {
    // Arrange
    const { controller, out } = harness({ probes: [undefined], serviceFallback: stoppedReport });

    // Act
    await controller.status({ json: true });

    // Assert — a machine reader must still get parseable stdout alongside the non-zero exit.
    const payload: unknown = JSON.parse(out.lines[0]?.replace('ok: ', '') ?? '');
    should(payload).have.property('reachability', 'stopped');
    should(out.exitCode).equal(1);
  });

  it('should hand the daemon-reported pid to a supervisor that owns no unit', async () => {
    // Arrange
    const { controller, direct } = harness({
      probes: [health()],
      serviceInstalled: false,
      directFallback: { manager: 'direct', state: 'running', pid: 4242 },
    });

    // Act
    await controller.status({});

    // Assert
    should(direct.calls).containEql('inspect:4242');
  });
});

describe('daemon logs', () => {
  it('should stream the configured log file', async () => {
    // Arrange
    const { controller, logs } = harness({});

    // Act
    await controller.logs({});

    // Assert
    should(logs.shown).deepEqual([{ file: layout().logFile, follow: false }]);
  });

  it('should follow when asked', async () => {
    // Arrange
    const { controller, logs } = harness({});

    // Act
    await controller.logs({ follow: true });

    // Assert
    should(logs.shown).deepEqual([{ file: layout().logFile, follow: true }]);
  });

  it('should say the log does not exist rather than print nothing', async () => {
    // Arrange — kteam swallowed the read error, which reads identically to an empty log.
    const { controller, out, logs } = harness({ logs: new FakeLogs(false) });

    // Act
    await controller.logs({});

    // Assert
    should(out.text).match(/^warn: no fyd log at .*logs\/fyd\.log yet$/u);
    should(logs.shown).be.empty();
  });

  it('should still follow a log that does not exist yet, because tail -F waits for it', async () => {
    // Arrange
    const { controller, logs } = harness({ logs: new FakeLogs(false) });

    // Act
    await controller.logs({ follow: true });

    // Assert
    should(logs.shown).have.length(1);
  });

  it('should adopt the exit code of a failed stream', async () => {
    // Arrange
    const { controller, out } = harness({ logs: new FakeLogs(true, 2) });

    // Act
    await controller.logs({});

    // Assert
    should(out.exitCode).equal(2);
  });
});

describe('daemon controller defaults', () => {
  it('should fall back to the shipped policies when none are injected', async () => {
    // Arrange
    const service = new FakeSupervisor('systemd', runningReport);
    const controller = new DaemonController({
      layout: layout(),
      service,
      direct: new FakeSupervisor('direct', absentReport),
      health: new FakeHealth([health()]),
      logs: new FakeLogs(),
      clock: new SteppingClock(),
      out: new CapturedOutput(),
    });

    // Act
    await controller.status({});

    // Assert — construction with no policy must not throw, and the default status path must work.
    should(service.calls).containEql('installed');
  });
});
