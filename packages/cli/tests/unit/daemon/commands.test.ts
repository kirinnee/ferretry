import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerDaemonCommands } from '../../../src/lib/daemon/commands';
import { DaemonController } from '../../../src/lib/daemon/controller';
import { StateHomeClaimService } from '../../../src/lib/state-home/claim';
import { StateHomeController } from '../../../src/lib/state-home/controller';
import { CapturedOutput as CapturedClaimOutput, FakeStateHomeFiles } from '../state-home/fixtures';
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
  health,
  installedDaemon,
  layout,
  RecordingFirstPassword,
  runningReport,
  SteppingClock,
  stoppedReport,
} from './fixtures';

function run(
  argv: string[],
  probes: ReadonlyArray<ReturnType<typeof health> | undefined> = [health()],
): {
  parsed: Promise<unknown>;
  service: FakeSupervisor;
  out: CapturedOutput;
  logs: FakeLogs;
  adopted: CapturedClaimOutput;
  built: () => number;
  resetTrees: FakeResetTrees;
  prompt: FakePrompt;
} {
  const service = new FakeSupervisor('systemd', stoppedReport);
  const out = new CapturedOutput();
  const logs = new FakeLogs();
  const resetTrees = new FakeResetTrees();
  const prompt = new FakePrompt();
  let builds = 0;
  // A home already carrying our marker, so `adopt` in this suite exercises the routing rather than
  // the decision — the decision has its own suite against the real service.
  const claimOut = new CapturedClaimOutput();
  const adoptController = (): StateHomeController =>
    new StateHomeController(
      new StateHomeClaimService(
        new FakeStateHomeFiles([{ name: 'layout-version', directory: false }], '1\n'),
        'fy daemon adopt',
      ),
      '/tmp/fy-home/.ferretry',
      claimOut,
    );
  const program = new Command().name('fy').exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerDaemonCommands(
    program,
    () => {
      builds += 1;
      return new DaemonController({
        layout: layout(),
        service,
        direct: new FakeSupervisor('direct', absentReport),
        health: new FakeHealth(probes),
        logs,
        nix: new FakeNixGcRoot(),
        lifecycle: new FakeLifecycleLock(),
        installedDaemon: () => installedDaemon(),
        retired: new FakeRetiredArtifacts(),
        resetTrees,
        resetInventory: new FakeResetInventory({ secrets: 1, devices: 1 }),
        prompt,
        // No terminal, so `reset` routes here and then refuses unless `--yes` was passed. That is what
        // this suite is for: the flag reaching the controller, not the decision it drives.
        interactive: () => false,
        clientName: 'fy',
        clock: new SteppingClock(),
        out,
        firstPassword: new RecordingFirstPassword(),
        readiness: { deadlineMs: 1_000, cadenceMs: 10, progressAfterMs: 300 },
        shutdown: { deadlineMs: 1_000, cadenceMs: 10, escalateAfterMs: 300 },
      });
    },
    adoptController,
  );
  return {
    parsed: program.parseAsync(['node', 'fy', ...argv]),
    service,
    out,
    logs,
    adopted: claimOut,
    built: () => builds,
    resetTrees,
    prompt,
  };
}

describe('daemon command surface', () => {
  it('should route install to the controller', async () => {
    // Arrange + Act
    const { parsed, service } = run(['daemon', 'install']);
    await parsed;

    // Assert
    should(service.calls).containEql('install');
  });

  it('should route uninstall to the controller', async () => {
    // Arrange + Act
    const { parsed, service } = run(['daemon', 'uninstall']);
    await parsed;

    // Assert
    should(service.calls).containEql('uninstall');
  });

  it('should route start to the controller', async () => {
    // Arrange + Act
    const { parsed, out } = run(['daemon', 'start']);
    await parsed;

    // Assert
    should(out.text).equal('ok: fyd is already serving (pid 4242)');
  });

  it('should route stop to the controller', async () => {
    // Arrange + Act
    const { parsed, service } = run(['daemon', 'stop'], [health(), undefined]);
    await parsed;

    // Assert
    should(service.stops).have.length(1);
  });

  it('should route restart to the controller', async () => {
    // Arrange + Act
    const { parsed, service } = run(['daemon', 'restart'], [health(), undefined, health()]);
    await parsed;

    // Assert
    should(service.calls).containEql('stop');
    should(service.calls).containEql('start');
  });

  it('should route reset to the controller once --yes authorizes it', async () => {
    // Arrange + Act — no terminal in this suite, so `--yes` is what makes the verb reachable at all.
    const { parsed, resetTrees, out } = run(['daemon', 'reset', '--yes'], [undefined]);
    await parsed;

    // Assert — both roots, from the layout rather than from anything this command line spelled.
    should(resetTrees.removed).deepEqual(['/tmp/fy-home/.ferretry', '/tmp/fy-home/.local/state/ferretry']);
    should(out.text).containEql('nothing was removed');
  });

  it('should accept -y as the short form, the same as every other destructive verb', async () => {
    // Arrange + Act
    const { parsed, resetTrees } = run(['daemon', 'reset', '-y'], [undefined]);
    await parsed;

    // Assert
    should(resetTrees.removed).have.length(2);
  });

  it('should refuse reset with no flag and no terminal, rather than silently skipping the guard', async () => {
    // Arrange + Act
    const { parsed, resetTrees } = run(['daemon', 'reset'], [undefined]);

    // Assert
    await should(parsed).be.rejectedWith(/pass --yes to authorize it/u);
    should(resetTrees.removed).be.empty();
  });

  it('should print a human status by default', async () => {
    // Arrange + Act
    const { parsed, out } = run(['daemon', 'status']);
    await parsed;

    // Assert
    should(out.text).startWith('ok: fyd is serving');
  });

  it('should print machine status behind --json', async () => {
    // Arrange + Act
    const { parsed, out } = run(['daemon', 'status', '--json']);
    await parsed;

    // Assert
    should(JSON.parse(out.lines[0]?.replace('ok: ', '') ?? '')).have.property('daemon', 'fyd');
  });

  it('should route which and its JSON flag through the daemon controller', async () => {
    const { parsed, out } = run(['daemon', 'which', '--json']);
    await parsed;
    should(JSON.parse(out.lines[0]?.replace('ok: ', '') ?? '')).have.property('installed');
  });

  it('should print the log', async () => {
    // Arrange + Act
    const { parsed, logs } = run(['daemon', 'logs']);
    await parsed;

    // Assert
    should(logs.shown).deepEqual([{ file: layout().logFile, follow: false }]);
  });

  it('should follow the log behind -f', async () => {
    // Arrange + Act
    const { parsed, logs } = run(['daemon', 'logs', '-f']);
    await parsed;

    // Assert
    should(logs.shown[0]?.follow).be.true();
  });

  it('should accept the long form of the follow flag', async () => {
    // Arrange + Act
    const { parsed, logs } = run(['daemon', 'logs', '--follow']);
    await parsed;

    // Assert
    should(logs.shown[0]?.follow).be.true();
  });

  it('should route adopt to the state-home controller', async () => {
    // Arrange + Act — the repair the daemon's own refusal names has to exist and be reachable.
    const { parsed, adopted } = run(['daemon', 'adopt']);
    await parsed;

    // Assert
    should(adopted.text).containEql('already a claimed Ferretry state home');
  });

  it('should pass --json through to adopt, like its siblings', async () => {
    // Arrange + Act
    const { parsed, adopted } = run(['daemon', 'adopt', '--json']);
    await parsed;

    // Assert
    should(JSON.parse(adopted.text)).have.property('outcome', 'already-claimed');
  });

  it.each([
    { name: 'the snapshot group itself', verb: ['snapshot'] },
    { name: 'snapshot build', verb: ['snapshot', 'build'] },
    { name: 'snapshot list', verb: ['snapshot', 'list'] },
    { name: 'snapshot promote', verb: ['snapshot', 'promote', `sha256-${'b'.repeat(64)}`] },
  ])('should no longer mount $name', async ({ verb }) => {
    // Arrange + Act — the snapshot store is gone, and so is every verb that managed it. This is the
    // surface an operator sees, so its absence is asserted here rather than left to a grep.
    const { parsed, built } = run(['daemon', ...verb]);

    // Assert — commander rejects an unknown verb and the controller is never even constructed.
    await should(parsed).be.rejected();
    should(built()).equal(0);
  });

  it('should build the controller only when a verb actually runs', async () => {
    // Arrange + Act — resolving the layout can fail, so `fy --help` must never construct it.
    const { parsed, built } = run(['daemon', '--help']);

    // Assert
    await should(parsed).be.rejected();
    should(built()).equal(0);
  });

  it('should reject an unknown daemon verb', async () => {
    // Arrange + Act
    const { parsed } = run(['daemon', 'frobnicate']);

    // Assert
    await should(parsed).be.rejected();
  });

  it('should surface a controller failure as a rejection the composition root can report', async () => {
    // Arrange
    const out = new CapturedOutput();
    const service = new FakeSupervisor('systemd', runningReport);
    const program = new Command().name('fy').exitOverride();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    registerDaemonCommands(
      program,
      () => {
        throw new Error('cannot find fyd on PATH');
      },
      () => {
        throw new Error('this test never reaches adopt');
      },
    );

    // Act + Assert
    await should(program.parseAsync(['node', 'fy', 'daemon', 'start'])).be.rejectedWith(/cannot find fyd on PATH/u);
    should(out.lines).be.empty();
    should(service.calls).be.empty();
  });
});
