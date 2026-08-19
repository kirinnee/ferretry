import { describe, it } from 'bun:test';
import type { HealthView } from '@ferretry/protocol';
import should from 'should';
import {
  DaemonController,
  type DaemonControllerDeps,
  DaemonResetRefusedError,
  DaemonShutdownFailedError,
  DaemonStartupFailedError,
} from '../../../src/lib/daemon/controller';
import type { DaemonSupervisorReport } from '../../../src/lib/daemon/ports';
import { ResetRefusedError } from '../../../src/lib/daemon/reset';
import { UnsupportedServiceManagerError } from '../../../src/lib/daemon/supervisor';
import {
  absentReport,
  CapturedOutput,
  FakeHealth,
  FakeLifecycleLock,
  FakeLogs,
  FakeNixGcRoot,
  FakePrompt,
  FakeResetInventory,
  FakeResetTrees,
  FakeRetiredArtifacts,
  FakeSupervisor,
  failedReport,
  HOME,
  health,
  installedDaemon,
  layout,
  RecordingFirstPassword,
  runningReport,
  SteppingClock,
  stoppedReport,
} from './fixtures';

interface Harness {
  readonly controller: DaemonController;
  readonly firstPassword: RecordingFirstPassword;
  readonly out: CapturedOutput;
  readonly service: FakeSupervisor;
  readonly direct: FakeSupervisor;
  readonly logs: FakeLogs;
  readonly clock: SteppingClock;
  readonly nix: FakeNixGcRoot;
  readonly retired: FakeRetiredArtifacts;
  readonly lifecycle: FakeLifecycleLock;
  readonly resetTrees: FakeResetTrees;
  readonly prompt: FakePrompt;
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
  retired?: FakeRetiredArtifacts;
  lifecycle?: FakeLifecycleLock;
  resetTrees?: FakeResetTrees;
  inventory?: { readonly secrets: number; readonly devices: number } | undefined;
  prompt?: FakePrompt;
  interactive?: boolean;
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
  const retired = options.retired ?? new FakeRetiredArtifacts();
  const lifecycle = options.lifecycle ?? new FakeLifecycleLock();
  const firstPassword = new RecordingFirstPassword();
  const resetTrees = options.resetTrees ?? new FakeResetTrees();
  const prompt = options.prompt ?? new FakePrompt();
  const controller = new DaemonController({
    layout: layout(),
    service: options.withoutService === true ? undefined : service,
    direct,
    health: new FakeHealth(options.probes ?? [health()]),
    logs,
    nix,
    lifecycle,
    installedDaemon: () => installedDaemon(),
    retired,
    resetTrees,
    // `in` rather than `??`: an explicit `undefined` is the meaningful case — a daemon that is up but
    // will not answer the inventory routes — so it must not fall back to the default counts.
    resetInventory: new FakeResetInventory('inventory' in options ? options.inventory : { secrets: 3, devices: 2 }),
    prompt,
    interactive: () => options.interactive ?? true,
    clientName: 'fy',
    clock,
    out,
    firstPassword,
    readiness: { deadlineMs: 1_000, cadenceMs: 10, progressAfterMs: 300 },
    shutdown: { deadlineMs: 1_000, cadenceMs: 10, escalateAfterMs: 300 },
    ...options.overrides,
  });
  return { controller, out, service, direct, logs, clock, nix, retired, lifecycle, firstPassword, resetTrees, prompt };
}

/** A host with no daemon executable: the resolver refuses, as it does for a relative FY_DAEMON_BIN. */
function noDaemonInstalled(): () => never {
  return () => {
    throw new Error('cannot find fyd on PATH — install it or point FY_DAEMON_BIN at the executable');
  };
}

describe('daemon install', () => {
  it('should install through the service manager and report the daemon it brought up', async () => {
    // Arrange
    const { controller, out, service } = harness({ probes: [undefined, health()] });

    // Act
    await controller.install();

    // Assert — the ABSOLUTE path of the installed executable, which is the only thing systemd can
    // load: a relative `ExecStart` fails the unit with 203/EXEC at the next boot with nobody watching.
    should(service.calls).containEql('install');
    should(service.installedExecutables).deepEqual([installedDaemon().path]);
    should(service.installedExecutables[0]?.startsWith('/')).be.true();
    should(out.text).containEql('fyd user service installed from');
    should(out.text).containEql('and started (pid 4242)');
  });

  it('should refuse on a host with no service manager instead of writing a Linux unit anyway', async () => {
    // Arrange
    const { controller } = harness({ withoutService: true });

    // Act + Assert
    await should(controller.install()).be.rejectedWith(UnsupportedServiceManagerError);
  });

  it('should refuse before touching the service manager when no daemon is installed', async () => {
    // Arrange — there is no copy of the executable to fall back to any more, so an invocation that
    // cannot name a file must say so rather than write a definition naming something it guessed.
    const { controller, service, nix } = harness({
      probes: [undefined, health()],
      overrides: { installedDaemon: noDaemonInstalled() },
    });

    // Act + Assert
    await should(controller.install()).be.rejectedWith(/cannot find fyd on PATH/u);
    should(service.calls).be.empty();
    should(nix.pinned).be.empty();
  });

  it('should report a daemon that installed but died during startup', async () => {
    // Arrange — the unit installs, systemd starts it, the daemon exits before serving.
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
  it('should remove the definition and say the closure stays held', async () => {
    // Arrange
    const { controller, out, service, nix } = harness({});

    // Act
    await controller.uninstall();

    // Assert — removing supervision does not uninstall the daemon, and `fy daemon start` still runs
    // that same executable as a direct child. Releasing the root here could leave that start with no
    // executable at all after a garbage collection.
    should(service.calls).containEql('uninstall');
    should(nix.released).be.empty();
    should(out.text).startWith('ok: fyd user service removed');
    should(out.text).containEql(layout().nixGcRoot);
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

  it('should say so when the daemon already serving is older than the installed one', async () => {
    // Arrange — the upgrade an operator actually performs: a package manager replaced the executable
    // and the daemon from before it is still serving.
    const { controller, out, service } = harness({
      probes: [health({ version: '0.143.0' })],
      overrides: { installedDaemon: () => installedDaemon({ version: '0.175.3' }) },
    });

    // Act
    await controller.start();

    // Assert — said, never acted on: a `start` that killed a working daemon to apply an upgrade
    // nobody asked for is the surprise this whole surface avoids.
    should(out.text).containEql('the running fyd is version 0.143.0');
    should(out.text).containEql('/opt/fy/bin/fyd is 0.175.3');
    should(out.text).match(/fy daemon restart/u);
    should(service.calls).not.containEql('start');
  });

  it('should stay silent about a running daemon whose version cannot be read', async () => {
    // Arrange — a wrong "restart me" is worse than silence, so an unknown version says nothing.
    const { controller, out } = harness({
      probes: [health()],
      overrides: { installedDaemon: () => installedDaemon({ version: undefined }) },
    });

    // Act
    await controller.start();

    // Assert
    should(out.text).equal('ok: fyd is already serving (pid 4242)');
  });

  it('should stay silent about a host with no daemon installed at all', async () => {
    // Arrange
    const { controller, out } = harness({
      probes: [health()],
      overrides: { installedDaemon: noDaemonInstalled() },
    });

    // Act
    await controller.start();

    // Assert — the daemon is serving; there is nothing for the operator to do about the PATH now.
    should(out.text).equal('ok: fyd is already serving (pid 4242)');
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
    should(service.startedExecutables).deepEqual([installedDaemon().path]);
    should(out.text).equal('ok: fyd ready (pid 4242)');
  });

  it('should refuse before touching the service manager when no daemon is installed', async () => {
    // Arrange
    const { controller, service } = harness({
      probes: [undefined, health()],
      serviceReports: [stoppedReport],
      overrides: { installedDaemon: noDaemonInstalled() },
    });

    // Act + Assert
    await should(controller.start()).be.rejectedWith(/cannot find fyd on PATH/u);
    should(service.calls).not.containEql('start');
  });

  it('should leave a supervised incumbent alone while its API is temporarily unavailable', async () => {
    // Arrange
    const { controller, out, service, nix } = harness({
      probes: [undefined, health()],
      serviceFallback: runningReport,
    });

    // Act
    await controller.start();

    // Assert — wait for the incumbent rather than rewriting its unit and its root underneath it.
    should(out.text).equal('ok: fyd ready (pid 4242)');
    should(service.calls).not.containEql('start');
    should(nix.realPaths).be.empty();
  });

  it('should compare an incumbent that becomes ready against the installed daemon', async () => {
    // Arrange — the same staleness question, asked about a daemon this verb waited for rather than
    // one that was already answering when it arrived.
    const { controller, out } = harness({
      probes: [undefined, health({ version: '0.143.0' })],
      serviceFallback: runningReport,
      overrides: { installedDaemon: () => installedDaemon({ version: '0.175.3' }) },
    });

    // Act
    await controller.start();

    // Assert
    should(out.text).containEql('the running fyd is version 0.143.0');
    should(out.text).endWith('ok: fyd ready (pid 4242)');
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
    should(direct.startedExecutables).deepEqual([installedDaemon().path]);
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

  it('should offer the first operator password after the transaction, and only after a start', async () => {
    // WHY IT IS AFTER THE RELEASE. The offer can put a question in front of a person, and a question
    // asked while the lifecycle claim is held would block every other `fy daemon …` invocation on this
    // host until somebody answered it — so `daemon stop` in another terminal would look wedged, and the
    // remedy would be killing the terminal that was asking. The trail is the only way to state that.
    // Arrange — the offer writes into the LOCK's own trail, which is the only way to state ordering.
    const lifecycle = new FakeLifecycleLock();
    const offer = new RecordingFirstPassword(lifecycle.trail);
    const started = harness({
      probes: [undefined, health()],
      serviceFallback: stoppedReport,
      lifecycle,
      overrides: { firstPassword: offer },
    });
    const claims = layout().lifecycleLocks.length;

    // Act
    await started.controller.start();

    // Assert — every claim is released before the question is asked.
    should(offer.offers).equal(1);
    should(lifecycle.trail).deepEqual([
      ...Array.from({ length: claims }, () => 'acquire:start'),
      ...Array.from({ length: claims }, () => 'release:start'),
      'offer:first-password',
    ]);

    // And no OTHER verb asks. `restart` in particular meets an operator who is mid-incident, and a
    // prompt between them and a daemon that is down is the last thing that surface should add.
    const installed = harness({ probes: [undefined, health()] });
    await installed.controller.install();
    const restarted = harness({
      probes: [health(), undefined, health()],
      serviceReports: [stoppedReport],
      serviceFallback: stoppedReport,
    });
    await restarted.controller.restart();
    const stopped = harness({ probes: [health(), undefined], serviceFallback: stoppedReport });
    await stopped.controller.stop();
    should([installed.firstPassword.offers, restarted.firstPassword.offers, stopped.firstPassword.offers]).deepEqual([
      0, 0, 0,
    ]);
  });

  it('should ask nothing when the daemon never came up', async () => {
    // A daemon that did not start is not a machine anybody is finishing the setup of, and the person in
    // front of it has a failure to read. `start` throws before the offer, which is what proves it.
    // Arrange
    const { controller, firstPassword } = harness({ probes: [undefined], serviceFallback: stoppedReport });

    // Act
    await controller.start().catch(() => undefined);

    // Assert
    should(firstPassword.offers).equal(0);
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

/**
 * A reset harness whose daemon is up and stops when asked.
 *
 * The shared harness defaults its supervisor to `running` forever, which is a shutdown that never
 * takes — correct for the stop suite and wrong as the baseline here, where the interesting cases are
 * about the confirmation and the two trees rather than about a stubborn daemon. Every test that IS about
 * a stop that will not take arranges that explicitly.
 */
function resetSubject(options: Parameters<typeof harness>[0] = {}): Harness {
  return harness({
    probes: [health(), undefined],
    serviceFallback: stoppedReport,
    serviceReports: [stoppedReport],
    ...options,
  });
}

/** Both roots, populated, so a reset has something to find and to report. */
function populatedTrees(trail: string[] = []): FakeResetTrees {
  const trees = new FakeResetTrees(trail);
  const resolved = layout();
  trees.answers.set(resolved.stateHome, { kind: 'measured', files: 40, bytes: 2_000_000, escapingLinks: [] });
  trees.answers.set(resolved.stateArtifactRoot, {
    kind: 'measured',
    files: 12,
    bytes: 98_000_000,
    escapingLinks: ['nix/fyd -> /nix/store/abc-fyd'],
  });
  return trees;
}

describe('daemon reset', () => {
  it('should remove BOTH roots, not just the state home everybody looks in', async () => {
    // Arrange — the defect this verb exists for: an owner cleared the state home by hand, kept the
    // artifact tree, and went on running the pinned daemon executable inside it.
    const resolved = layout();
    const subject = resetSubject({ resetTrees: populatedTrees(), probes: [health(), undefined] });

    // Act
    await subject.controller.reset({ yes: true });

    // Assert
    should(subject.resetTrees.removed).deepEqual([resolved.stateHome, resolved.stateArtifactRoot]);
    should(subject.out.text).containEql(`removed ${resolved.stateHome}`);
    should(subject.out.text).containEql(`removed ${resolved.stateArtifactRoot}`);
    should(subject.out.text).containEql('removed 2 path(s), 52 files, 100.0MB');
  });

  it('should show the paths, the sizes and the unrecoverable counts BEFORE it destroys anything', async () => {
    // Arrange
    const trail: string[] = [];
    const subject = resetSubject({ resetTrees: populatedTrees(trail), probes: [health(), undefined] });

    // Act
    await subject.controller.reset({ yes: true });

    // Assert — measured first, removed after, and the preflight names what cannot come back. Health
    // reports 3 sessions and the inventory 3 secrets and 2 devices.
    should(trail.filter(entry => entry.startsWith('measure:'))).have.length(2);
    should(trail.indexOf('measure:/tmp/fy-home/.ferretry')).be.below(trail.indexOf('remove:/tmp/fy-home/.ferretry'));
    should(subject.out.text).containEql('3 secret(s)');
    should(subject.out.text).containEql('2 paired device(s)');
    should(subject.out.text).containEql('3 session(s)');
    should(subject.out.text).containEql('100.0MB');
  });

  it('should stop the daemon before it removes anything', async () => {
    // Arrange — the order is the safety argument. Moving state out from under a running daemon is
    // exactly the half-state this verb exists to stop people reaching by hand.
    const trail: string[] = [];
    const trees = populatedTrees(trail);
    const subject = resetSubject({
      resetTrees: trees,
      probes: [health(), undefined],
      serviceFallback: stoppedReport,
      serviceReports: [stoppedReport],
    });

    // Act
    await subject.controller.reset({ yes: true });

    // Assert
    should(subject.service.stops).deepEqual([{ pidHint: 4242, escalate: false }]);
    should(subject.service.calls.indexOf('stop')).be.above(-1);
    should(trail.filter(entry => entry.startsWith('remove:'))).have.length(2);
  });

  it('should refuse the whole reset when the daemon cannot be stopped, having removed nothing', async () => {
    // Arrange — health keeps answering, so the daemon refuses to go. A reset that carried on would
    // delete the state a live daemon is still writing into.
    const trees = populatedTrees();
    const subject = resetSubject({ resetTrees: trees, probes: [health()], serviceFallback: runningReport, step: 600 });

    // Act
    let caught: unknown;
    try {
      await subject.controller.reset({ yes: true });
    } catch (error) {
      caught = error;
    }

    // Assert — the refusal is the shutdown failure, and NOTHING was removed. The measurement happened,
    // because it happens before the stop and touches nothing.
    should(caught).be.instanceof(DaemonShutdownFailedError);
    should(trees.removed).be.empty();
    should(trees.measured).have.length(2);
  });

  it('should reset a daemon that is already stopped, without pressing a stop', async () => {
    // Arrange — the ordinary recovery case: somebody whose daemon will not start.
    const subject = resetSubject({
      resetTrees: populatedTrees(),
      probes: [undefined],
      serviceFallback: stoppedReport,
    });

    // Act
    await subject.controller.reset({ yes: true });

    // Assert
    should(subject.service.stops).be.empty();
    should(subject.resetTrees.removed).have.length(2);
  });

  it('should say the counts are unavailable, never guess, when the daemon is not answering', async () => {
    // Arrange — the daemon owns those counts. It is down, so there is nobody to ask, and the CLI does
    // not read its state to find out.
    const subject = resetSubject({ resetTrees: populatedTrees(), probes: [undefined], serviceFallback: stoppedReport });

    // Act
    await subject.controller.reset({ yes: true });

    // Assert
    should(subject.out.text).containEql('fyd is not running,');
    should(subject.out.text).containEql('cannot be counted');
  });

  it('should still reset when the daemon is up but will not answer the inventory routes', async () => {
    // Arrange — a damaged secret store, or a daemon mid-bootstrap. Counting is a courtesy; the reset is
    // the point, and a reset that failed because it could not count would be unreachable exactly when
    // it is needed.
    const subject = resetSubject({
      resetTrees: populatedTrees(),
      probes: [health(), undefined],
      inventory: undefined,
      serviceFallback: stoppedReport,
      serviceReports: [stoppedReport],
    });

    // Act
    await subject.controller.reset({ yes: true });

    // Assert
    should(subject.out.text).containEql('cannot be counted');
    should(subject.resetTrees.removed).have.length(2);
  });

  it('should require a typed confirmation at a terminal, and remove nothing until it arrives', async () => {
    // Arrange
    const trees = populatedTrees();
    const prompt = new FakePrompt('reset');
    const subject = resetSubject({ resetTrees: trees, prompt, probes: [health(), undefined] });

    // Act
    await subject.controller.reset({});

    // Assert
    should(prompt.asked).deepEqual(['Type "reset" to confirm:']);
    should(trees.removed).have.length(2);
  });

  it('should cancel on any answer that is not the word, having removed nothing', async () => {
    // Arrange — a bare `y` is precisely the answer this refuses. Something deliberate has to be typed.
    const trees = populatedTrees();
    const subject = resetSubject({ resetTrees: trees, prompt: new FakePrompt('y'), probes: [health(), undefined] });

    // Act
    let caught: unknown;
    try {
      await subject.controller.reset({});
    } catch (error) {
      caught = error;
    }

    // Assert
    should(caught).be.instanceof(DaemonResetRefusedError);
    should((caught as Error).message).equal('reset cancelled');
    should(trees.removed).be.empty();
    should(subject.service.stops).be.empty();
  });

  it('should accept the word with surrounding whitespace, which is what a terminal delivers', async () => {
    // Arrange
    const subject = resetSubject({
      resetTrees: populatedTrees(),
      prompt: new FakePrompt(' reset \n'),
      probes: [health(), undefined],
    });

    // Act
    await subject.controller.reset({});

    // Assert
    should(subject.resetTrees.removed).have.length(2);
  });

  it('should refuse off a terminal unless --yes was passed, rather than skip the guard', async () => {
    // Arrange — the failure mode that makes a safety prompt decorative: no TTY, so nobody could type,
    // so the guard silently does not apply. An unattended run has to say so out loud.
    const trees = populatedTrees();
    const subject = resetSubject({ resetTrees: trees, interactive: false, probes: [health(), undefined] });

    // Act
    let caught: unknown;
    try {
      await subject.controller.reset({});
    } catch (error) {
      caught = error;
    }

    // Assert
    should(caught).be.instanceof(DaemonResetRefusedError);
    should((caught as Error).message).equal(
      'refusing to reset fyd without a confirmation — pass --yes to authorize it',
    );
    should(trees.removed).be.empty();
  });

  it('should not ask anything when --yes was passed, on a terminal or off one', async () => {
    // Arrange
    const prompt = new FakePrompt();
    const subject = resetSubject({ resetTrees: populatedTrees(), prompt, probes: [health(), undefined] });

    // Act
    await subject.controller.reset({ yes: true });

    // Assert
    should(prompt.asked).be.empty();
  });

  it('should refuse a root that cannot be a Ferretry directory before it measures anything', async () => {
    // Arrange — FY_HOME pointing at the home directory itself. The refusal has to land while nothing
    // has been touched, which means before the first measurement.
    const trees = new FakeResetTrees();
    const subject = resetSubject({
      resetTrees: trees,
      probes: [health(), undefined],
      overrides: { layout: layout({ stateHome: HOME }) },
    });

    // Act
    let caught: unknown;
    try {
      await subject.controller.reset({ yes: true });
    } catch (error) {
      caught = error;
    }

    // Assert
    should(caught).be.instanceof(ResetRefusedError);
    should((caught as Error).message).match(/resolves to the home directory itself/u);
    should(trees.measured).be.empty();
    should(trees.removed).be.empty();
  });

  it('should surface a removal that failed rather than report a clean slate', async () => {
    // Arrange — a tree that cannot be removed. Half a reset reported as a whole one is the one outcome
    // worse than a refusal, because the person walks away believing it worked.
    const trees = populatedTrees();
    trees.removalFailure = new Error('EACCES: permission denied');
    const subject = resetSubject({ resetTrees: trees, probes: [health(), undefined], serviceReports: [stoppedReport] });

    // Act + Assert
    await should(subject.controller.reset({ yes: true })).be.rejectedWith(/EACCES/);
    should(subject.out.text).not.containEql('clean slate');
  });

  it('should report plainly when there was nothing on this host to remove', async () => {
    // Arrange — a second reset, or a host that never started the daemon.
    const subject = resetSubject({
      resetTrees: new FakeResetTrees(),
      probes: [undefined],
      serviceFallback: stoppedReport,
    });

    // Act
    await subject.controller.reset({ yes: true });

    // Assert
    should(subject.out.text).containEql('fyd had no persistent data on this host; nothing was removed');
  });

  it('should name the command that brings the machine back, and the password it will offer', async () => {
    // Arrange
    const subject = resetSubject({ resetTrees: populatedTrees(), probes: [health(), undefined] });

    // Act
    await subject.controller.reset({ yes: true });

    // Assert — a clean slate is only useful if somebody knows the next move.
    should(subject.out.text).containEql('Run `fy daemon start` to bring fyd up on a clean slate');
    should(subject.out.text).containEql('operator password');
  });

  it('should name the links inside the trees that point out of them', async () => {
    // Arrange — the artifact tree holds garbage-collection links into the Nix store, and following one
    // would recursively delete a store output.
    const subject = resetSubject({ resetTrees: populatedTrees(), probes: [health(), undefined] });

    // Act
    await subject.controller.reset({ yes: true });

    // Assert
    should(subject.out.text).containEql('nix/fyd -> /nix/store/abc-fyd');
    should(subject.out.text).containEql('NOTHING it points at is read, followed or removed');
  });

  it('should hold the lifecycle claims across the prompt and the removal, as one transaction', async () => {
    // Arrange — a peer `start` between the answer and the deletion would recreate the state home under
    // a removal that had already been authorized. The prompt is inside the claim for that reason, and
    // the cost — a peer waiting while somebody reads — is the right trade for this one verb.
    const lifecycle = new FakeLifecycleLock();
    const trail: string[] = [];
    const trees = new FakeResetTrees(trail);
    const subject = resetSubject({ lifecycle, resetTrees: trees, probes: [undefined], serviceFallback: stoppedReport });

    // Act
    await subject.controller.reset({ yes: true });

    // Assert
    should(lifecycle.requests.map(request => request.verb)).deepEqual(['reset', 'reset', 'reset', 'reset']);
    should(lifecycle.trail[0]).equal('acquire:reset');
    should(lifecycle.trail.at(-1)).equal('release:reset');
    should(trail).have.length(4);
  });

  it('should never ask for the operator password, because forgetting it is a reason to reset', async () => {
    // Arrange — the second escape hatch alongside `fy daemon password set`. A reset gated on the
    // password would close the door it exists to open.
    const subject = resetSubject({ resetTrees: populatedTrees(), probes: [health(), undefined] });

    // Act
    await subject.controller.reset({});

    // Assert — the only thing asked for is the confirmation word.
    should(subject.prompt.asked).deepEqual(['Type "reset" to confirm:']);
    should(subject.firstPassword.offers).equal(0);
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
    should(service.startedExecutables).deepEqual([installedDaemon().path]);
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
    should(service.startedExecutables).deepEqual([installedDaemon().path]);
    should(out.lines[0]).equal('warn: fyd was not running; starting it');
    should(out.text).containEql('ok: fyd restarted (pid 4242)');
  });

  it('should refuse a host with no daemon installed while the healthy one is still serving', async () => {
    // Arrange — this is downtime the verb cannot undo, so the executable is located BEFORE the stop.
    // A host that cannot name one has to learn that while its daemon is still up.
    const trail: string[] = [];
    const subject = harness({
      probes: [health(), undefined, health()],
      serviceReports: [stoppedReport],
      serviceFallback: stoppedReport,
      overrides: { installedDaemon: noDaemonInstalled() },
    });
    const stop = subject.service.stop.bind(subject.service);
    subject.service.stop = async request => {
      trail.push('stop');
      await stop(request);
    };

    // Act + Assert
    await should(subject.controller.restart()).be.rejectedWith(/cannot find fyd on PATH/u);
    should(trail).be.empty();
    should(subject.service.calls).not.containEql('start');
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

  it('should say when the serving daemon is older than the installed one', async () => {
    // Arrange
    const { controller, out } = harness({
      probes: [health({ version: '0.143.0' })],
      overrides: { installedDaemon: () => installedDaemon({ version: '0.175.3' }) },
    });

    // Act
    await controller.status({});

    // Assert
    should(out.text).containEql('the running fyd is version 0.143.0');
    should(out.text).containEql('fy daemon restart');
  });

  it('should keep --json parseable by never mixing that notice into it', async () => {
    // Arrange — a machine reader gets one document on stdout and nothing else.
    const { controller, out } = harness({
      probes: [health({ version: '0.143.0' })],
      overrides: { installedDaemon: () => installedDaemon({ version: '0.175.3' }) },
    });

    // Act
    await controller.status({ json: true });

    // Assert
    should(out.lines).have.length(1);
    should(JSON.parse(out.lines[0]?.replace('ok: ', '') ?? '')).have.property('daemon', 'fyd');
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

  it('should report a daemon that exists but does not answer', async () => {
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

/**
 * `which` reports TWO identities now, and the third one's absence is the point.
 *
 * It used to report installed, promoted and running, and the middle one was most of what the command
 * was for: an operator who had upgraded the executable and was still being served by a snapshot
 * promoted weeks earlier had no other way to see it. There is no promoted anything now, so the only
 * question left is whether the daemon serving right now predates the one on this host's PATH.
 */
describe('daemon which', () => {
  it('should name both identities and confirm when they agree', async () => {
    // Arrange
    const { controller, out } = harness({ probes: [health()] });

    // Act
    await controller.which({});

    // Assert
    should(out.text).containEql('installed: /opt/fy/bin/fyd (PATH, version 1.2.3)');
    should(out.text).containEql('running: pid 4242 version 1.2.3');
    should(out.text).containEql('the running daemon is the installed one');
  });

  it('should name the remedy when the running daemon predates the installed one', async () => {
    // Arrange
    const { controller, out } = harness({
      probes: [health({ version: '0.143.0' })],
      overrides: { installedDaemon: () => installedDaemon({ version: '0.175.3', source: 'FY_DAEMON_BIN' }) },
    });

    // Act
    await controller.which({});

    // Assert
    should(out.text).containEql('installed: /opt/fy/bin/fyd (FY_DAEMON_BIN, version 0.175.3)');
    should(out.text).containEql('running and installed differ; run fy daemon restart');
  });

  it('should compare nothing when the installed version cannot be read', async () => {
    // Arrange
    const { controller, out } = harness({
      probes: [health()],
      overrides: { installedDaemon: () => installedDaemon({ version: undefined }) },
    });

    // Act
    await controller.which({});

    // Assert
    should(out.text).containEql('installed: /opt/fy/bin/fyd (PATH, version unknown)');
    should(out.text).not.containEql('differ');
    should(out.text).not.containEql('the running daemon is the installed one');
  });

  it('should report WHY a daemon could not be located rather than a bare absence', async () => {
    // Arrange — "not installed" and "installed somewhere a service manager cannot launch" need
    // different remedies, and only the resolver knows which one this is.
    const { controller, out } = harness({
      probes: [undefined],
      serviceFallback: stoppedReport,
      overrides: {
        installedDaemon: () => {
          throw new Error('fyd must be an absolute path for a user service to launch it');
        },
      },
    });

    // Act
    await controller.which({});

    // Assert
    should(out.text).containEql('installed: fyd must be an absolute path for a user service to launch it');
    should(out.text).containEql('running: daemon is not running');
  });

  it('should render both identities as JSON', async () => {
    // Arrange
    const { controller, out } = harness({
      probes: [health()],
      overrides: { installedDaemon: () => installedDaemon({ version: '0.175.3' }) },
    });

    // Act
    await controller.which({ json: true });

    // Assert
    const payload: unknown = JSON.parse(out.lines[0]?.replace('ok: ', '') ?? '');
    should(payload).have.property('installed').with.property('version', '0.175.3');
    should(payload).have.property('running').with.property('version', '1.2.3');
    should(payload).not.have.property('promoted');
  });

  it('should render a located failure as JSON too', async () => {
    // Arrange
    const { controller, out } = harness({
      probes: [undefined],
      serviceFallback: stoppedReport,
      overrides: { installedDaemon: noDaemonInstalled() },
    });

    // Act
    await controller.which({ json: true });

    // Assert
    const payload: unknown = JSON.parse(out.lines[0]?.replace('ok: ', '') ?? '');
    should(payload).have.property('installed').with.property('state', 'not-found');
    should(payload).have.property('running').with.property('state', 'not-running');
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
 * service, which then fails to launch at the next login with nobody there to read the error.
 *
 * The owner has waived the case where their OWN shell goes stale afterwards. That waiver is about an
 * interactive session they are present for; it is not about a user service that silently stops coming
 * up at boot, and the absolute path a unit file must record is exactly the path a collection deletes.
 *
 * ONE ROOT, because there is one executable. The per-snapshot roots existed because a snapshot's
 * copied executable still loaded its interpreter and libraries from the store output it was copied
 * FROM, so every rollback candidate needed that output held. There are no copies and no rollback
 * candidates now.
 */
describe('nix garbage-collection root', () => {
  const PROFILE_BINARY = `${HOME}/.nix-profile/bin/fyd`;
  const STORE_BINARY = '/nix/store/q1w2e3r4t5y6u7i8o9p0asdfghjklzxc-ferretry-0.125.0/bin/fyd';
  const STORE_PATH = '/nix/store/q1w2e3r4t5y6u7i8o9p0asdfghjklzxc-ferretry-0.125.0';
  const ROOT = layout().nixGcRoot;

  /** A harness whose daemon is reached through a profile link that resolves into the Nix store. */
  function fromTheStore(options: Parameters<typeof harness>[0] = {}): ReturnType<typeof harness> {
    const nix = options.nix ?? new FakeNixGcRoot();
    nix.links.set(PROFILE_BINARY, STORE_BINARY);
    return harness({
      ...options,
      nix,
      overrides: { installedDaemon: () => installedDaemon({ path: PROFILE_BINARY }), ...options.overrides },
    });
  }

  it.each([
    { verb: 'install' as const, options: { probes: [undefined, health()] } },
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
  ])('should pin the store output of the launched executable on $verb', async ({ verb, options }) => {
    // Arrange
    const subject = fromTheStore(options);

    // Act
    await subject.controller[verb]();

    // Assert — the ROOT of the store output, not the executable inside it: `nix-store --realise`
    // takes a store path. The link is resolved first, because only the real path tells a `nix profile`
    // or `nix shell` installation apart from a Homebrew or GoReleaser one.
    should(subject.nix.realPaths).deepEqual([PROFILE_BINARY]);
    should(subject.nix.pinned).deepEqual([{ storePath: STORE_PATH, rootPath: ROOT }]);
    should(subject.out.text).not.containEql('could not be pinned');
  });

  it('should release a stale root when the installed daemon is no longer from the store', async () => {
    // Arrange — the fixture's daemon is a plain /opt install, as brew or GoReleaser leaves it. A root
    // from an earlier Nix installation would otherwise hold that closure forever.
    const subject = harness({ probes: [undefined, health()], serviceReports: [stoppedReport] });

    // Act
    await subject.controller.start();

    // Assert
    should(subject.nix.pinned).be.empty();
    should(subject.nix.released).deepEqual([ROOT]);
    should(subject.out.text).containEql('fyd ready');
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
    should(subject.out.text).containEql(STORE_PATH);
    should(subject.out.text).containEql('nix profile install');
    should(subject.out.text).containEql('fyd ready');
    should(subject.out.exitCode).be.undefined();
  });

  it('should hold the closure before the definition names the path it holds', async () => {
    // Arrange — the two halves of a lifecycle verb. A definition that named a store path nothing was
    // holding is a unit that can stop loading between this command and the next boot.
    const trail: string[] = [];
    const subject = fromTheStore({ probes: [undefined, health()] });
    const pin = subject.nix.pin.bind(subject.nix);
    subject.nix.pin = async (storePath, rootPath) => {
      trail.push('pin');
      return await pin(storePath, rootPath);
    };
    const install = subject.service.install.bind(subject.service);
    subject.service.install = async executable => {
      trail.push('install');
      await install(executable);
    };

    // Act
    await subject.controller.install();

    // Assert
    should(trail).deepEqual(['pin', 'install']);
  });

  it('should keep the root outside the state home, which the daemon refuses to share', async () => {
    // Arrange — a CLI-created path inside the state home is the defect that stopped every fresh
    // machine from starting the daemon, and this root is a symbolic link besides, which the daemon's
    // filesystem port refuses anywhere under its home.

    // Act
    const actual = layout();

    // Assert
    should(actual.nixGcRoot).equal('/tmp/fy-home/.local/state/ferretry/nix/fyd');
    should(actual.nixGcRoot.startsWith(`${actual.stateHome}/`)).be.false();
  });
});

/**
 * The daemon snapshot store an earlier release left behind, and why a lifecycle verb removes it.
 *
 * An upgraded host has roughly 100MB of copies of an executable it already has installed, plus one Nix
 * root per copy. Leaving it there means every operator carries that forever and finds a directory
 * nothing accounts for; telling them to remove it in release notes is an instruction almost nobody
 * follows. The cleanup runs, it says what it did, and it never fails the verb it is attached to.
 */
describe('retired snapshot store', () => {
  const ROOTS = layout().legacySnapshotGcRootDirectory;
  const STORE = layout().legacySnapshotRoot;

  /** A host that ran the release with the snapshot store: a populated store and one root per copy. */
  function upgraded(options: Parameters<typeof harness>[0] = {}): ReturnType<typeof harness> {
    const nix = options.nix ?? new FakeNixGcRoot();
    nix.heldNames = [`sha256-${'a'.repeat(64)}`, `sha256-${'b'.repeat(64)}`];
    const retired = options.retired ?? new FakeRetiredArtifacts();
    retired.answers.set(ROOTS, { kind: 'removed', files: 2, bytes: 0 });
    retired.answers.set(STORE, { kind: 'removed', files: 6, bytes: 104_857_600 });
    return harness({ ...options, nix, retired });
  }

  it('should say nothing at all on a host that never had one', async () => {
    // Arrange — the ordinary case, and the one that must not narrate. A fresh install has no store.
    const subject = harness({ probes: [undefined, health()], serviceReports: [stoppedReport] });

    // Act
    await subject.controller.start();

    // Assert — it still LOOKS, because an upgraded host is indistinguishable until it does.
    should(subject.retired.retired).deepEqual([ROOTS, STORE]);
    should(subject.out.text).equal('ok: fyd ready (pid 4242)');
  });

  it.each([
    { verb: 'install' as const, options: { probes: [undefined, health()] } },
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
    { verb: 'uninstall' as const, options: {} },
  ])('should remove the store and its roots on $verb, and say how much came back', async ({ verb, options }) => {
    // Arrange
    const subject = upgraded(options);

    // Act
    await subject.controller[verb]();

    // Assert — every per-snapshot root is released through the Nix port, both directories go, and the
    // reclaimed disk is stated once rather than quietly deleted.
    should(subject.nix.released.filter(path => path.startsWith(`${ROOTS}/`))).deepEqual([
      `${ROOTS}/sha256-${'a'.repeat(64)}`,
      `${ROOTS}/sha256-${'b'.repeat(64)}`,
    ]);
    should(subject.retired.retired).deepEqual([ROOTS, STORE]);
    should(subject.out.text).containEql('removed the retired fyd snapshot store (8 files, 104.9MB)');
    should(subject.out.text).containEql('runs the daemon installed on this host instead of a copy of it');
  });

  it('should remove it only after the definition no longer names anything inside it', async () => {
    // Arrange — THE SAFETY ARGUMENT. An upgraded host's unit file still names an artifact inside the
    // store, so a removal that ran first would leave a service that cannot launch. `start` rewrites
    // the definition with the installed executable's absolute path, and only then is nothing pointing
    // at the store.
    const trail: string[] = [];
    const retired = new FakeRetiredArtifacts();
    const subject = upgraded({ probes: [undefined, health()], serviceReports: [stoppedReport], retired });
    const start = subject.service.start.bind(subject.service);
    subject.service.start = async executable => {
      trail.push('start');
      return await start(executable);
    };
    const retire = retired.retire.bind(retired);
    retired.retire = async path => {
      trail.push('retire');
      return await retire(path);
    };

    // Act
    await subject.controller.start();

    // Assert
    should(trail).deepEqual(['start', 'retire', 'retire']);
  });

  it('should leave the store alone when the start it was attached to failed', async () => {
    // Arrange — the definition was rewritten but the daemon never served, so the operator may still
    // need whatever is on this host. Tidying is not worth taking that away mid-incident.
    const subject = upgraded({ probes: [undefined], serviceFallback: stoppedReport });

    // Act + Assert
    await should(subject.controller.start()).be.rejectedWith(DaemonStartupFailedError);
    should(subject.retired.retired).be.empty();
  });

  it('should name what it could not remove instead of failing the verb', async () => {
    // Arrange — reclaiming disk is tidying; the daemon in front of the operator is the work.
    const retired = new FakeRetiredArtifacts();
    retired.answers.set(STORE, { kind: 'failed', reason: 'EACCES' });
    const subject = harness({ probes: [undefined, health()], serviceReports: [stoppedReport], retired });

    // Act
    await subject.controller.start();

    // Assert
    should(subject.out.text).containEql(`could not remove its retired snapshot store at ${STORE} (EACCES)`);
    should(subject.out.text).containEql('safe to delete by hand');
    should(subject.out.text).containEql('ok: fyd ready (pid 4242)');
    should(subject.out.exitCode).be.undefined();
  });
});

/**
 * Two `fy daemon` invocations are unrelated, so nothing in this object can order them.
 *
 * Each mutating verb holds the executable's garbage-collection root and then writes a service
 * definition or launches that executable, and those halves have to agree about which file is in play.
 * A peer that interleaves them leaves a unit naming one executable while the root holds another's
 * closure, so the whole verb runs inside one ordered daemon-keyed claim set — and the reporting verbs
 * stay outside it, because a `status` that waited on a slow `restart` would make the tool useless
 * exactly when it is needed.
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
    { verb: 'status', claimed: undefined, options: {}, run: (c: DaemonController) => c.status({}) },
    { verb: 'logs', claimed: undefined, options: {}, run: (c: DaemonController) => c.logs({}) },
    { verb: 'which', claimed: undefined, options: {}, run: (c: DaemonController) => c.which({}) },
  ])('should run $verb inside the daemon-keyed claims named $claimed', async ({ options, claimed, run }) => {
    // Arrange
    const subject = harness(options);
    const lockPaths = layout().lifecycleLocks;

    // Act
    await run(subject.controller);

    // Assert — a reporting verb takes nothing: a `status` that queued behind a slow `restart` would
    // be useless exactly when somebody needs it.
    should(subject.lifecycle.trail).deepEqual(
      claimed === undefined
        ? []
        : [...lockPaths.map(() => `acquire:${claimed}`), ...lockPaths.map(() => `release:${claimed}`)],
    );
    should(subject.lifecycle.requests.map(request => request.lockPath)).deepEqual(
      claimed === undefined ? [] : lockPaths,
    );
    should(subject.lifecycle.releasedPaths).deepEqual(claimed === undefined ? [] : [...lockPaths].reverse());
  });

  it('should give every claim shutdown, startup, and reconciliation headroom', async () => {
    // Arrange — a peer inside `restart` legitimately spends both waits plus the root-holding and
    // retirement work, so a shorter bound would refuse a command queued behind a healthy one.
    const subject = harness({ probes: [health()] });

    // Act
    await subject.controller.start();

    // Assert
    should(subject.lifecycle.requests.map(request => request.waitMs)).deepEqual(
      layout().lifecycleLocks.map(() => 32_000),
    );
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
    should(subject.retired.retired).be.empty();
    should(subject.nix.pinned).be.empty();
    should(subject.lifecycle.releasedPaths).be.empty();
  });

  it('should give the claim up even when the verb fails', async () => {
    // Arrange — a start that never becomes ready must not leave the host unable to run any other
    // lifecycle command.
    const subject = harness({ probes: [undefined], serviceFallback: stoppedReport });
    const lockPaths = layout().lifecycleLocks;

    // Act + Assert
    await should(subject.controller.start()).be.rejectedWith(DaemonStartupFailedError);
    should(subject.lifecycle.trail).deepEqual([
      ...lockPaths.map(() => 'acquire:start'),
      ...lockPaths.map(() => 'release:start'),
    ]);
    should(subject.lifecycle.releasedPaths).deepEqual([...lockPaths].reverse());
  });

  it('should give back an earlier claim when a later ownership target is busy', async () => {
    // Arrange — a manager-backed platform claims four ownership targets. A refusal on the final,
    // direct-fallback target must not strand any earlier claim or run any lifecycle work.
    const lifecycle = new FakeLifecycleLock();
    const lockPaths = layout().lifecycleLocks;
    lifecycle.refusal = new Error('the direct-fallback lifecycle claim is busy');
    lifecycle.refusalAt = lockPaths.length;
    const subject = harness({ lifecycle, probes: [undefined, health()], serviceReports: [stoppedReport] });

    // Act + Assert
    await should(subject.controller.start()).be.rejectedWith(/direct-fallback lifecycle claim is busy/u);
    const acquired = lockPaths.slice(0, -1);
    should(subject.lifecycle.trail).deepEqual([
      ...acquired.map(() => 'acquire:start'),
      ...acquired.map(() => 'release:start'),
    ]);
    should(subject.lifecycle.requests.map(request => request.lockPath)).deepEqual(lockPaths);
    should(subject.lifecycle.releasedPaths).deepEqual([...acquired].reverse());
    should(subject.service.calls).be.empty();
    should(subject.retired.retired).be.empty();
    should(subject.nix.pinned).be.empty();
  });

  it('should say what is holding the claim rather than appear to hang', async () => {
    // Arrange
    const lifecycle = new FakeLifecycleLock();
    lifecycle.holder = 'held by restart (owner 4242, since 2026-08-06T00:00:00.000Z): that owner is still running';
    const subject = harness({ lifecycle, probes: [health()] });

    // Act
    await subject.controller.start();

    // Assert
    should(subject.out.text).containEql('fyd start is waiting up to 32s for another lifecycle command to finish');
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
      installedDaemon: () => installedDaemon(),
      retired: new FakeRetiredArtifacts(),
      resetTrees: new FakeResetTrees(),
      resetInventory: new FakeResetInventory(undefined),
      prompt: new FakePrompt(),
      interactive: () => false,
      clientName: 'fy',
      clock: new SteppingClock(),
      out: new CapturedOutput(),
      firstPassword: new RecordingFirstPassword(),
    });

    // Act
    await controller.status({});

    // Assert — construction with no policy must not throw, and the default status path must work.
    should(service.calls).containEql('installed');
  });
});
