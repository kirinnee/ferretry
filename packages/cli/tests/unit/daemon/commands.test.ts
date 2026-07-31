import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerDaemonCommands } from '../../../src/lib/daemon/commands';
import { DaemonController } from '../../../src/lib/daemon/controller';
import {
  absentReport,
  CapturedOutput,
  FakeHealth,
  FakeLogs,
  FakeSupervisor,
  health,
  layout,
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
  built: () => number;
} {
  const service = new FakeSupervisor('systemd', stoppedReport);
  const out = new CapturedOutput();
  const logs = new FakeLogs();
  let builds = 0;
  const program = new Command().name('fy').exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerDaemonCommands(program, () => {
    builds += 1;
    return new DaemonController({
      layout: layout(),
      service,
      direct: new FakeSupervisor('direct', absentReport),
      health: new FakeHealth(probes),
      logs,
      clock: new SteppingClock(),
      out,
      readiness: { deadlineMs: 1_000, cadenceMs: 10, progressAfterMs: 300 },
      shutdown: { deadlineMs: 1_000, cadenceMs: 10, escalateAfterMs: 300 },
    });
  });
  return { parsed: program.parseAsync(['node', 'fy', ...argv]), service, out, logs, built: () => builds };
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
    registerDaemonCommands(program, () => {
      throw new Error('cannot find fyd on PATH');
    });

    // Act + Assert
    await should(program.parseAsync(['node', 'fy', 'daemon', 'start'])).be.rejectedWith(/cannot find fyd on PATH/u);
    should(out.lines).be.empty();
    should(service.calls).be.empty();
  });
});
