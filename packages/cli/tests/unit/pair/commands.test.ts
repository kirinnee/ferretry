import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerPairCommands } from '../../../src/lib/pair/commands';
import { type PairDeps, PairController } from '../../../src/lib/pair/controller';
import {
  CapturingExit,
  CapturingScreen,
  expired,
  FakeClock,
  FixedTerminalSize,
  RecordingProgress,
  ScriptedPairGateway,
  StubQrEncoder,
} from './fixtures';

function run(argv: string[]) {
  const gateway = new ScriptedPairGateway([expired]);
  const screen = new CapturingScreen();
  const qr = new StubQrEncoder();
  const deps: PairDeps = {
    gateway,
    screen,
    progress: new RecordingProgress(),
    exit: new CapturingExit(),
    clock: new FakeClock(),
    qr,
    terminal: new FixedTerminalSize(100),
    binaryName: 'fy',
  };
  const program = new Command().name('fy').exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerPairCommands(program, new PairController(deps));
  return { parsed: program.parseAsync(['node', 'fy', ...argv]), gateway, screen, qr };
}

describe('pair command surface', () => {
  it('should pair with no flags at all', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['pair']);
    await parsed;

    // Assert
    should(gateway.minted).equal(1);
  });

  it('should ask for a full-size QR under --large', async () => {
    // Arrange + Act
    const { parsed, qr } = run(['pair', '--large']);
    await parsed;

    // Assert
    should(qr.requests[0]?.size).equal('large');
  });

  it('should print and leave under --no-wait, polling nothing', async () => {
    // Arrange + Act
    const { parsed, gateway, screen } = run(['pair', '--no-wait']);
    await parsed;

    // Assert
    should(screen.writes).have.length(1);
    should(gateway.polled).be.empty();
  });

  it('should offer no --name, because the device names itself when it redeems', async () => {
    // Arrange + Act + Assert — the daemon's mint is bodyless, so a host-side label has nowhere to go.
    await should(run(['pair', '--name', 'Pixel']).parsed).be.rejected();
  });

  it('should offer no --json, because the only secret here is the code', async () => {
    // Arrange + Act + Assert
    await should(run(['pair', '--json']).parsed).be.rejected();
  });
});
