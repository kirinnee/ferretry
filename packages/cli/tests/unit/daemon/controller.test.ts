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
  daemonSnapshot,
  FakeHealth,
  FakeLifecycleLock,
  FakeLogs,
  FakeNixGcRoot,
  FakeSnapshots,
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
  readonly snapshots: FakeSnapshots;
  readonly clock: SteppingClock;
  readonly nix: FakeNixGcRoot;
  readonly lifecycle: FakeLifecycleLock;
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
  snapshots?: FakeSnapshots;
  step?: number;
  nix?: FakeNixGcRoot;
  lifecycle?: FakeLifecycleLock;
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
  const snapshots = options.snapshots ?? new FakeSnapshots();
  const clock = new SteppingClock(options.step ?? 100);
  const nix = options.nix ?? new FakeNixGcRoot();
  const lifecycle = options.lifecycle ?? new FakeLifecycleLock();
  const controller = new DaemonController({
    layout: layout(),
    service: options.withoutService === true ? undefined : service,
    direct,
    health: new FakeHealth(options.probes ?? [health()]),
    logs,
    nix,
    lifecycle,
    snapshots,
    clock,
    out,
    readiness: { deadlineMs: 1_000, cadenceMs: 10, progressAfterMs: 300 },
    shutdown: { deadlineMs: 1_000, cadenceMs: 10, escalateAfterMs: 300 },
    ...options.overrides,
  });
  return { controller, out, service, direct, logs, snapshots, clock, nix, lifecycle };
}

describe('daemon install', () => {
  it('should install through the service manager and report the daemon it brought up', async () => {
    // Arrange
    const { controller, out, service } = harness({ probes: [undefined, health()] });

    // Act
    await controller.install();

    // Assert
    should(service.calls).containEql('install');
    should(service.installedExecutables).deepEqual([daemonSnapshot().binaryPath]);
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
    should(out.text).startWith('ok: fyd user service removed');
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
    const { controller, out, service } = harness({
      probes: [undefined, undefined, health()],
      serviceReports: [stoppedReport],
    });

    // Act
    await controller.start();

    // Assert
    should(service.calls).containEql('start');
    should(service.startedExecutables).deepEqual([daemonSnapshot().binaryPath]);
    should(out.text).equal('ok: fyd ready (pid 4242)');
  });

  it('should leave a supervised incumbent alone while its API is temporarily unavailable', async () => {
    // Arrange
    const { controller, out, service, snapshots, nix } = harness({
      probes: [undefined, health()],
      serviceFallback: runningReport,
    });

    // Act
    await controller.start();

    // Assert — wait for the incumbent rather than rewriting its unit and sole GC root underneath it.
    // Such a rewrite could leave snapshot A running while only snapshot B's closure is protected.
    should(out.text).equal('ok: fyd ready (pid 4242)');
    should(service.calls).not.containEql('start');
    should(snapshots.calls).be.empty();
    should(nix.realPaths).be.empty();
  });

  it('should report when a supervised incumbent exits before its API becomes ready', async () => {
    // Arrange
    const { controller, clock } = harness({
      probes: [undefined],
      serviceReports: [runningReport, failedReport],
      serviceFallback: failedReport,
    });

    // Act + Assert
    await should(controller.start()).be.rejectedWith(/exited during startup/u);
    should(clock.slept).be.empty();
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
    should(direct.startedExecutables).deepEqual([daemonSnapshot().binaryPath]);
    should(service.calls).not.containEql('start');
  });

  it('should note progress once when a slow boot passes the progress threshold', async () => {
    // Arrange — the clock advances 100ms per read, so the 300ms threshold arrives mid-wait.
    const { controller, out } = harness({
      probes: [undefined, undefined, undefined, undefined, health()],
      serviceReports: [stoppedReport],
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
    should(service.startedExecutables).deepEqual([daemonSnapshot().binaryPath]);
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
    should(service.startedExecutables).deepEqual([daemonSnapshot().binaryPath]);
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
 *
 * And it holds ONE ROOT PER RETAINED SNAPSHOT. A single per-daemon root could protect only the closure
 * of whatever ran last, so promoting a newer snapshot silently disarmed every older one: the rollback
 * candidate kept its verified executable and lost the loader and libraries that executable needs.
 */
describe('nix garbage-collection root', () => {
  const STORE_BINARY = '/nix/store/q1w2e3r4t5y6u7i8o9p0asdfghjklzxc-ferretry-0.125.0/bin/fyd';
  const STORE_PATH = '/nix/store/q1w2e3r4t5y6u7i8o9p0asdfghjklzxc-ferretry-0.125.0';
  const OLDER_BINARY = '/nix/store/zxcvbnmasdfghjklq1w2r3y4i5p6a7s8-ferretry-0.124.0/bin/fyd';
  const OLDER_PATH = '/nix/store/zxcvbnmasdfghjklq1w2r3y4i5p6a7s8-ferretry-0.124.0';
  const ROOTS = layout().nixGcRootDirectory;

  /**
   * A harness whose daemon executable resolves into the Nix store, as `nix shell` leaves it.
   *
   * A store fixture supplied by the caller is left exactly as it was: the interesting cases here are
   * about SEVERAL retained snapshots, and a helper that overwrote the store's contents with one would
   * quietly turn every one of them back into the single-snapshot case it is meant to disprove.
   */
  function fromTheStore(options: Parameters<typeof harness>[0] = {}): ReturnType<typeof harness> {
    let snapshots = options.snapshots;
    if (snapshots === undefined) {
      snapshots = new FakeSnapshots();
      const snapshot = daemonSnapshot({ sourceBinary: STORE_BINARY });
      snapshots.currentAnswer = snapshot;
      snapshots.buildAnswer = { ...snapshot, created: true };
      snapshots.listAnswer = [snapshot];
    }
    const nix = options.nix ?? new FakeNixGcRoot();
    nix.links.set(STORE_BINARY, STORE_BINARY);
    return harness({ ...options, nix, snapshots });
  }

  it.each([
    { verb: 'install' as const, options: { serviceInstalled: false } },
    {
      verb: 'start' as const,
      options: { probes: [undefined, health()], serviceReports: [stoppedReport] as DaemonSupervisorReport[] },
    },
    {
      verb: 'restart' as const,
      options: {
        probes: [health(), undefined, health()],
        serviceReports: [stoppedReport] as DaemonSupervisorReport[],
        serviceFallback: stoppedReport,
      },
    },
  ])('should pin the store path under the launched snapshot on $verb', async ({ verb, options }) => {
    // Arrange
    const subject = fromTheStore(options);

    // Act
    await subject.controller[verb]();

    // Assert — the ROOT of the store output, not the executable inside it: `nix-store --realise`
    // takes a store path. The copied current binary is outside the store, so its verified manifest
    // source — not the runtime symlink or today's configured build input — must drive classification.
    // The root is named for the snapshot, which is what makes a second snapshot a second root.
    should(subject.nix.realPaths).deepEqual([STORE_BINARY]);
    should(subject.nix.pinned).deepEqual([{ storePath: STORE_PATH, rootPath: `${ROOTS}/${daemonSnapshot().id}` }]);
    should(subject.out.text).not.containEql('could not be pinned');
  });

  it('should keep a distinct root per retained snapshot so a rollback candidate stays runnable', async () => {
    // Arrange — the exact shape the single-root design broke: an older Nix-built snapshot retained for
    // rollback, and a newer one being promoted over it.
    const older = daemonSnapshot({ id: `sha256-${'b'.repeat(64)}`, sourceBinary: OLDER_BINARY });
    const newer = daemonSnapshot({ sourceBinary: STORE_BINARY });
    const snapshots = new FakeSnapshots();
    snapshots.listAnswer = [newer, older];
    snapshots.currentAnswer = newer;
    const subject = fromTheStore({ snapshots, probes: [undefined, health()], serviceReports: [stoppedReport] });

    // Act
    await subject.controller.start();

    // Assert — two snapshots, two roots, two closures held. Nothing is released: the older snapshot is
    // still in the store, so its closure is still a rollback that has to work.
    should(subject.nix.pinned).deepEqual([
      { storePath: STORE_PATH, rootPath: `${ROOTS}/${newer.id}` },
      { storePath: OLDER_PATH, rootPath: `${ROOTS}/${older.id}` },
    ]);
    should(subject.nix.released).deepEqual([layout().supersededNixGcRoot]);
  });

  it('should keep the older root when a later snapshot is promoted over it', async () => {
    // Arrange — promotion is the moment the old design re-pointed its one root and disarmed the
    // rollback. Both snapshots already hold roots, so only the promoted one is re-registered.
    const older = daemonSnapshot({ id: `sha256-${'b'.repeat(64)}`, sourceBinary: OLDER_BINARY });
    const newer = daemonSnapshot({ sourceBinary: STORE_BINARY });
    const snapshots = new FakeSnapshots();
    snapshots.listAnswer = [newer, older];
    const nix = new FakeNixGcRoot();
    nix.heldNames = [newer.id, older.id];
    nix.links.set(OLDER_BINARY, OLDER_BINARY);
    const subject = fromTheStore({ snapshots, nix });

    // Act
    await subject.controller.promoteSnapshot(newer.id);

    // Assert — the older root is neither re-registered nor released; it simply stays.
    should(subject.nix.pinned).deepEqual([{ storePath: STORE_PATH, rootPath: `${ROOTS}/${newer.id}` }]);
    should(subject.nix.released).deepEqual([layout().supersededNixGcRoot]);
  });

  it('should give a snapshot its root as soon as it is built, before anything promotes it', async () => {
    // Arrange — a snapshot with no root is a rollback candidate a garbage collection can disarm
    // before it has ever been selected.
    const built = daemonSnapshot({ id: `sha256-${'e'.repeat(64)}`, sourceBinary: STORE_BINARY });
    const snapshots = new FakeSnapshots();
    snapshots.buildAnswer = { ...built, created: true };
    snapshots.listAnswer = [built];
    const subject = fromTheStore({ snapshots });

    // Act
    await subject.controller.buildSnapshot();

    // Assert
    should(subject.nix.pinned).deepEqual([{ storePath: STORE_PATH, rootPath: `${ROOTS}/${built.id}` }]);
  });

  it('should release a root whose snapshot is no longer retained, and only that one', async () => {
    // Arrange — the one lifetime that ends a root: the snapshot it protects is gone from the store,
    // so the closure is being held for a rollback candidate that does not exist.
    const retained = daemonSnapshot({ sourceBinary: STORE_BINARY });
    const departed = `sha256-${'f'.repeat(64)}`;
    const snapshots = new FakeSnapshots();
    snapshots.listAnswer = [retained];
    const nix = new FakeNixGcRoot();
    nix.heldNames = [retained.id, departed];
    const subject = fromTheStore({ snapshots, nix, probes: [undefined, health()], serviceReports: [stoppedReport] });

    // Act
    await subject.controller.start();

    // Assert
    should(subject.nix.released).deepEqual([`${ROOTS}/${departed}`, layout().supersededNixGcRoot]);
  });

  it('should keep the superseded single root while any closure it might hold is unheld', async () => {
    // Arrange — the upgrade path. Dropping the old one-per-daemon root while a registration is
    // failing could withdraw the only protection a retained closure still has.
    const subject = fromTheStore({ probes: [undefined, health()], serviceReports: [stoppedReport] });
    subject.nix.failure = 'nix-store is not on PATH';

    // Act
    await subject.controller.start();

    // Assert
    should(subject.nix.released).be.empty();
  });

  it('should keep the roots outside the state home, which the daemon refuses to share', async () => {
    // Arrange — a CLI-created path inside the state home is the defect that stopped every fresh
    // machine from starting the daemon, and these roots are symbolic links besides, which the
    // daemon's filesystem port refuses anywhere under its home.
    const subject = fromTheStore({ probes: [undefined, health()], serviceReports: [stoppedReport] });

    // Act
    await subject.controller.start();

    // Assert
    should(ROOTS).equal('/tmp/fy-home/.local/state/ferretry/nix/snapshots/fyd');
    should(ROOTS.startsWith(`${layout().stateHome}/`)).be.false();
    should(layout().supersededNixGcRoot).equal('/tmp/fy-home/.local/state/ferretry/nix/fyd');
  });

  it('should leave a binary that does not come from the store untouched', async () => {
    // Arrange — the fixture's daemon is a plain /opt install, as brew or GoReleaser would leave it.
    const subject = harness({ probes: [undefined, health()], serviceReports: [stoppedReport] });

    // Act
    await subject.controller.start();

    // Assert
    should(subject.nix.pinned).deepEqual([]);
    should(subject.out.text).containEql('fyd ready');
  });

  it('should pin the snapshot returned by first-run bootstrap', async () => {
    // Arrange — promotion returns the just-built manifest. The live source configured in the layout
    // is deliberately /opt, proving that the promoted manifest is the authority for what will run.
    const snapshots = new FakeSnapshots();
    const built = daemonSnapshot({ id: `sha256-${'c'.repeat(64)}`, sourceBinary: STORE_BINARY });
    snapshots.currentAnswer = undefined;
    snapshots.buildAnswer = { ...built, created: true };
    snapshots.listAnswer = [built];
    const nix = new FakeNixGcRoot();
    const subject = harness({ serviceInstalled: false, probes: [undefined, health()], snapshots, nix });

    // Act
    await subject.controller.install();

    // Assert
    should(snapshots.calls).deepEqual(['current', 'build', `promote:${built.id}`, 'list']);
    should(nix.realPaths).deepEqual([STORE_BINARY]);
    should(nix.pinned).deepEqual([{ storePath: STORE_PATH, rootPath: `${ROOTS}/${built.id}` }]);
  });

  it('should launch the exact snapshot it verified and pinned even when promotion moves concurrently', async () => {
    // Arrange
    const snapshots = new FakeSnapshots();
    const selected = daemonSnapshot({
      id: `sha256-${'c'.repeat(64)}`,
      sourceBinary: STORE_BINARY,
      binaryPath: '/immutable/snapshots/selected/fyd',
    });
    const later = daemonSnapshot({
      id: `sha256-${'d'.repeat(64)}`,
      sourceBinary: '/opt/fy/bin/later-fyd',
      binaryPath: '/immutable/snapshots/later/fyd',
    });
    snapshots.currentAnswer = selected;
    const nix = new FakeNixGcRoot();
    nix.links.set(STORE_BINARY, STORE_BINARY);
    nix.afterRealPath = () => {
      snapshots.currentAnswer = later;
    };
    const subject = harness({ probes: [undefined, health()], serviceReports: [stoppedReport], snapshots, nix });

    // Act
    await subject.controller.start();

    // Assert — promotion changed after capture, but pinning and execution stay bound to snapshot A.
    // Every retained snapshot is classified, so the captured one appears among them rather than alone.
    should(nix.realPaths).containEql(selected.sourceBinary);
    should(nix.pinned).deepEqual([{ storePath: STORE_PATH, rootPath: `${ROOTS}/${selected.id}` }]);
    should(subject.service.startedExecutables).deepEqual([selected.binaryPath]);
    should(subject.service.startedExecutables).not.containEql(later.binaryPath);
  });

  it('should start the daemon anyway when the pin fails, and say so', async () => {
    // Arrange — no `nix-store` on PATH is the ordinary case here, and it must not fail the start.
    const subject = fromTheStore({ probes: [undefined, health()], serviceReports: [stoppedReport] });
    subject.nix.failure = 'nix-store is not on PATH';

    // Act
    await subject.controller.start();

    // Assert
    should(subject.out.text).containEql('could not be pinned against garbage collection');
    should(subject.out.text).containEql('nix-store is not on PATH');
    should(subject.out.text).containEql('nix profile install');
    should(subject.out.text).containEql('fyd ready');
    should(subject.out.exitCode).be.undefined();
  });

  it('should keep a retained snapshot held through uninstall rather than disarming a rollback', async () => {
    // Arrange — removing the service does not retire a snapshot. This verb used to drop the daemon's
    // one root here, which withdrew protection from every snapshot still sitting in the store.
    const subject = fromTheStore();

    // Act
    await subject.controller.uninstall();

    // Assert — the retained snapshot's own root is untouched, and the operator is told the closures
    // stay held rather than left to discover a store path nothing accounts for.
    should(subject.nix.released).deepEqual([layout().supersededNixGcRoot]);
    should(subject.nix.released).not.containEql(`${ROOTS}/${daemonSnapshot().id}`);
    should(subject.out.text).containEql('user service removed; retained snapshot closures stay held in');
    should(subject.out.text).containEql(ROOTS);
  });
});

describe('daemon snapshots', () => {
  it('should bootstrap only a genuinely absent promoted snapshot before install', async () => {
    // Arrange
    const snapshots = new FakeSnapshots();
    snapshots.currentAnswer = undefined;
    const { controller, out, service } = harness({ probes: [undefined, health()], snapshots });

    // Act
    await controller.install();

    // Assert
    should(snapshots.calls).deepEqual(['current', 'build', `promote:${snapshots.buildAnswer.id}`, 'list']);
    should(service.calls).containEql('install');
    should(out.text).containEql(`built and promoted ${snapshots.buildAnswer.id}`);
  });

  it('should fail closed before stopping a daemon when the promoted snapshot is damaged', async () => {
    // Arrange
    const snapshots = new FakeSnapshots();
    snapshots.currentError = new Error('current snapshot digest mismatch');
    const { controller, service, nix } = harness({ snapshots });

    // Act + Assert
    await should(controller.restart()).be.rejectedWith(/digest mismatch/u);
    should(service.calls).be.empty();
    should(nix.realPaths).be.empty();
  });

  it('should build without promotion and say whether the content was new', async () => {
    // Arrange
    const snapshots = new FakeSnapshots();
    const first = harness({ snapshots });

    // Act
    await first.controller.buildSnapshot();
    snapshots.buildAnswer = { ...snapshots.buildAnswer, created: false };
    const second = harness({ snapshots });
    await second.controller.buildSnapshot();

    // Assert
    should(first.out.text).containEql(`${snapshots.buildAnswer.id} built from /opt/fy/bin/fyd`);
    should(second.out.text).containEql(`${snapshots.buildAnswer.id} already complete from /opt/fy/bin/fyd`);
  });

  it('should promote an exact older id through the same path used for rollout', async () => {
    // Arrange
    const snapshots = new FakeSnapshots();
    const older = daemonSnapshot({ id: `sha256-${'b'.repeat(64)}` });
    snapshots.listAnswer = [older];
    const { controller, out } = harness({ snapshots });

    // Act
    await controller.promoteSnapshot(older.id);

    // Assert
    should(snapshots.calls).deepEqual([`promote:${older.id}`, 'list']);
    should(out.text).equal(
      `ok: fyd snapshot ${older.id} promoted; the running daemon is unchanged until the next managed launch`,
    );
  });

  it('should render the promoted marker and a machine-readable snapshot list', async () => {
    // Arrange
    const snapshots = new FakeSnapshots();
    const older = daemonSnapshot({ id: `sha256-${'b'.repeat(64)}`, createdAt: '2026-08-03T12:00:00.000Z' });
    const current = daemonSnapshot();
    snapshots.listAnswer = [current, older];
    snapshots.currentAnswer = current;
    const human = harness({ snapshots });

    // Act
    await human.controller.listSnapshots({});
    const machine = harness({ snapshots });
    await machine.controller.listSnapshots({ json: true });

    // Assert
    should(human.out.text).containEql(`* ${current.id}`);
    should(human.out.text).containEql(`  ${older.id}`);
    const payload = JSON.parse(machine.out.lines[0]?.replace('ok: ', '') ?? '') as {
      snapshots?: Array<{ id?: string; current?: boolean }>;
    };
    should(payload.snapshots?.[0]).containEql({ id: current.id, current: true });
    should(payload.snapshots?.[1]).containEql({ id: older.id, current: false });
  });

  it('should report a clean empty snapshot store without pretending it is damaged', async () => {
    // Arrange
    const snapshots = new FakeSnapshots();
    snapshots.listAnswer = [];
    snapshots.currentAnswer = undefined;
    const { controller, out } = harness({ snapshots });

    // Act
    await controller.listSnapshots({});

    // Assert
    should(out.text).equal('warn: no fyd snapshots have been built');
  });
});

/**
 * Two `fy daemon` invocations are unrelated, so nothing in this object can order them.
 *
 * Each mutating verb reconciles garbage-collection roots and then writes a service definition or
 * launches an executable, and those halves have to agree about which snapshot is in play. A peer that
 * interleaves them leaves a unit naming one snapshot while the roots hold another's closure, so the
 * whole verb runs inside one daemon-keyed claim — and the reporting verbs stay outside it, because a
 * `status` that waited on a slow `restart` would make the tool useless exactly when it is needed.
 */
describe('daemon lifecycle serialization', () => {
  it.each([
    {
      verb: 'install',
      claimed: 'install',
      options: { probes: [undefined, health()] },
      run: (controller: DaemonController) => controller.install(),
    },
    { verb: 'uninstall', claimed: 'uninstall', options: {}, run: (c: DaemonController) => c.uninstall() },
    { verb: 'start', claimed: 'start', options: { probes: [health()] }, run: (c: DaemonController) => c.start() },
    {
      verb: 'stop',
      claimed: 'stop',
      options: { probes: [health(), undefined], serviceFallback: stoppedReport },
      run: (c: DaemonController) => c.stop(),
    },
    {
      verb: 'restart',
      claimed: 'restart',
      options: { probes: [undefined, health()], serviceFallback: stoppedReport },
      run: (c: DaemonController) => c.restart(),
    },
    { verb: 'snapshot build', claimed: 'snapshot build', options: {}, run: (c: DaemonController) => c.buildSnapshot() },
    { verb: 'status', claimed: undefined, options: {}, run: (c: DaemonController) => c.status({}) },
    { verb: 'logs', claimed: undefined, options: {}, run: (c: DaemonController) => c.logs({}) },
    { verb: 'snapshot list', claimed: undefined, options: {}, run: (c: DaemonController) => c.listSnapshots({}) },
  ])('should run $verb inside the daemon-keyed claim named $claimed', async ({ options, claimed, run }) => {
    // Arrange
    const subject = harness(options);

    // Act
    await run(subject.controller);

    // Assert — a reporting verb takes nothing: a `status` that queued behind a slow `restart` would
    // be useless exactly when somebody needs it.
    should(subject.lifecycle.trail).deepEqual(
      claimed === undefined ? [] : [`acquire:${claimed}`, `release:${claimed}`],
    );
    should(subject.lifecycle.requests.map(request => request.lockPath)).deepEqual(
      claimed === undefined ? [] : [layout().lifecycleLock],
    );
  });

  it('should claim the daemon-keyed path for a snapshot promotion too', async () => {
    // Arrange — promotion moves the pointer a launch reads and registers a root, so it is a mutating
    // lifecycle step even though it starts nothing.
    const subject = harness({});

    // Act
    await subject.controller.promoteSnapshot(daemonSnapshot().id);

    // Assert
    should(subject.lifecycle.trail).deepEqual(['acquire:snapshot promote', 'release:snapshot promote']);
  });

  it('should wait for a peer up to a whole shutdown plus a whole startup', async () => {
    // Arrange — a peer inside `restart` legitimately holds the claim for both waits, so a shorter
    // bound would refuse commands that were only ever queued behind a healthy one.
    const subject = harness({ probes: [health()] });

    // Act
    await subject.controller.start();

    // Assert
    should(subject.lifecycle.requests[0]?.waitMs).equal(2_000);
  });

  it('should do no work at all when the claim is refused', async () => {
    // Arrange — the claim is taken before anything is read or written, so a refusal cannot leave a
    // half-applied lifecycle behind.
    const lifecycle = new FakeLifecycleLock();
    lifecycle.refusal = new Error('another daemon lifecycle command still holds /state/lifecycle/fyd.lock');
    const subject = harness({ lifecycle, probes: [undefined, health()], serviceReports: [stoppedReport] });

    // Act + Assert
    await should(subject.controller.start()).be.rejectedWith(/still holds/u);
    should(subject.service.calls).be.empty();
    should(subject.snapshots.calls).be.empty();
    should(subject.nix.pinned).be.empty();
  });

  it('should give the claim up even when the verb fails', async () => {
    // Arrange — a start that never becomes ready must not leave the host unable to run any other
    // lifecycle command.
    const subject = harness({ probes: [undefined], serviceFallback: stoppedReport });

    // Act + Assert
    await should(subject.controller.start()).be.rejectedWith(DaemonStartupFailedError);
    should(subject.lifecycle.trail).deepEqual(['acquire:start', 'release:start']);
  });

  it('should say what is holding the claim rather than appear to hang', async () => {
    // Arrange
    const lifecycle = new FakeLifecycleLock();
    lifecycle.holder = 'held by restart (owner 4242, since 2026-08-06T00:00:00.000Z): that owner is still running';
    const subject = harness({ lifecycle, probes: [health()] });

    // Act
    await subject.controller.start();

    // Assert
    should(subject.out.text).containEql('fyd start is waiting up to 2s for another lifecycle command to finish');
    should(subject.out.text).containEql('owner 4242');
  });

  it('should name a claim it could not give up, because the next command will be blocked by it', async () => {
    // Arrange
    const lifecycle = new FakeLifecycleLock();
    lifecycle.residue = '/state/lifecycle/fyd.lock';
    const subject = harness({ lifecycle, probes: [health()] });

    // Act
    await subject.controller.start();

    // Assert
    should(subject.out.text).containEql('lifecycle claim /state/lifecycle/fyd.lock could not be released');
    should(subject.out.text).containEql('remove it once no fyd lifecycle command is running');
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
      lifecycle: new FakeLifecycleLock(),
      snapshots: new FakeSnapshots(),
      clock: new SteppingClock(),
      out: new CapturedOutput(),
    });

    // Act
    await controller.status({});

    // Assert — construction with no policy must not throw, and the default status path must work.
    should(service.calls).containEql('installed');
  });
});
