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
  FakeNixGcRoot,
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
  readonly nix: FakeNixGcRoot;
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
  nix?: FakeNixGcRoot;
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
  const nix = options.nix ?? new FakeNixGcRoot();
  const controller = new DaemonController({
    layout: layout(),
    service: options.withoutService === true ? undefined : service,
    direct,
    health: new FakeHealth(options.probes ?? [health()]),
    logs,
    nix,
    clock,
    out,
    readiness: { deadlineMs: 1_000, cadenceMs: 10, progressAfterMs: 300 },
    shutdown: { deadlineMs: 1_000, cadenceMs: 10, escalateAfterMs: 300 },
    ...options.overrides,
  });
  return { controller, out, service, direct, logs, clock, nix };
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

/**
 * `nix shell github:…` is a supported way to run this, and it leaves the executable in the Nix store
 * with nothing rooting it — so a later `nix-collect-garbage` deletes it out from under an installed
 * service, which then breaks with no user action. The CLI holds the root itself rather than refusing
 * the install, because refusing would be pushing our convenience onto the operator.
 */
describe('nix garbage-collection root', () => {
  const STORE_BINARY = '/nix/store/q1w2e3r4t5y6u7i8o9p0asdfghjklzxc-ferretry-0.125.0/bin/fyd';
  const STORE_PATH = '/nix/store/q1w2e3r4t5y6u7i8o9p0asdfghjklzxc-ferretry-0.125.0';

  /** A harness whose daemon executable resolves into the Nix store, as `nix shell` leaves it. */
  function fromTheStore(options: Parameters<typeof harness>[0] = {}): ReturnType<typeof harness> {
    const nix = new FakeNixGcRoot();
    nix.links.set(layout().daemonBinary, STORE_BINARY);
    return harness({ ...options, nix });
  }

  it.each([
    { verb: 'install' as const, options: { serviceInstalled: false } },
    { verb: 'start' as const, options: { probes: [undefined, health()] } },
    {
      verb: 'restart' as const,
      options: {
        probes: [health(), undefined, health()],
        serviceReports: [stoppedReport] as DaemonSupervisorReport[],
        serviceFallback: stoppedReport,
      },
    },
  ])('should pin the store path on $verb', async ({ verb, options }) => {
    // Arrange
    const subject = fromTheStore(options);

    // Act
    await subject.controller[verb]();

    // Assert — the ROOT of the store output, not the executable inside it: `nix-store --realise`
    // takes a store path, and rooting the output is what keeps the whole install alive.
    should(subject.nix.pinned).deepEqual([{ storePath: STORE_PATH, rootPath: layout().nixGcRoot }]);
    should(subject.out.text).not.containEql('could not be pinned');
  });

  it('should keep the root outside the state home, which the daemon refuses to share', async () => {
    // Arrange — a CLI-created path inside the state home is the defect that stopped every fresh
    // machine from starting the daemon, and this root is a symbolic link besides, which the daemon's
    // filesystem port refuses anywhere under its home.
    const subject = fromTheStore({ probes: [undefined, health()] });

    // Act
    await subject.controller.start();

    // Assert
    should(layout().nixGcRoot).equal('/tmp/fy-home/.local/state/ferretry/nix/fyd');
    should(layout().nixGcRoot.startsWith(`${layout().stateHome}/`)).be.false();
  });

  it('should leave a binary that does not come from the store untouched', async () => {
    // Arrange — the fixture's daemon is a plain /opt install, as brew or GoReleaser would leave it.
    const subject = harness({ probes: [undefined, health()] });

    // Act
    await subject.controller.start();

    // Assert
    should(subject.nix.pinned).deepEqual([]);
    should(subject.out.text).containEql('fyd ready');
  });

  it('should start the daemon anyway when the pin fails, and say so', async () => {
    // Arrange — no `nix-store` on PATH is the ordinary case here, and it must not fail the start.
    const nix = new FakeNixGcRoot();
    nix.links.set(layout().daemonBinary, STORE_BINARY);
    nix.failure = 'nix-store is not on PATH';
    const subject = harness({ probes: [undefined, health()], nix });

    // Act
    await subject.controller.start();

    // Assert
    should(subject.out.text).containEql('could not be pinned against garbage collection');
    should(subject.out.text).containEql('nix-store is not on PATH');
    should(subject.out.text).containEql('nix profile install');
    should(subject.out.text).containEql('fyd ready');
    should(subject.out.exitCode).be.undefined();
  });

  it('should release the root on uninstall so the store path is no longer held', async () => {
    // Arrange
    const subject = fromTheStore();

    // Act
    await subject.controller.uninstall();

    // Assert
    should(subject.nix.released).deepEqual([layout().nixGcRoot]);
    should(subject.out.text).containEql('user service removed');
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
      nix: new FakeNixGcRoot(),
      clock: new SteppingClock(),
      out: new CapturedOutput(),
    });

    // Act
    await controller.status({});

    // Assert — construction with no policy must not throw, and the default status path must work.
    should(service.calls).containEql('installed');
  });
});
