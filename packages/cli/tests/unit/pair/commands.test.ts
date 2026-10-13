import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerPairCommands } from '../../../src/lib/pair/commands';
import { PairController, type PairDeps } from '../../../src/lib/pair/controller';
import {
  CapturingExit,
  CapturingScreen,
  expired,
  FakeClock,
  FixedTerminalSize,
  RecordingBrowserOpener,
  RecordingProgress,
  ScriptedPairGateway,
  StubQrEncoder,
} from './fixtures';

function run(argv: string[], binaryName = 'fy') {
  const gateway = new ScriptedPairGateway([expired]);
  const screen = new CapturingScreen();
  const qr = new StubQrEncoder();
  const browser = new RecordingBrowserOpener();
  const deps: PairDeps = {
    gateway,
    screen,
    progress: new RecordingProgress(),
    exit: new CapturingExit(),
    clock: new FakeClock(),
    qr,
    terminal: new FixedTerminalSize(100),
    browser,
    binaryName,
  };
  const program = new Command().name(binaryName).exitOverride();
  const printed: string[] = [];
  program.configureOutput({ writeOut: text => printed.push(text), writeErr: () => {} });
  registerPairCommands(program, new PairController(deps));
  return { parsed: program.parseAsync(['node', binaryName, ...argv]), printed, gateway, screen, qr, browser };
}

describe('pair command surface', () => {
  it('should say nothing about a password, because minting needs none', async () => {
    // Arrange + Act
    const { parsed, printed } = run(['pair', '--help'], 'foo');
    await should(parsed).be.rejected();

    // Assert
    should(printed.join('').toLowerCase()).not.containEql('password');
  });

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

describe('pair --open', () => {
  it('is opt-in: the plain command opens nothing', async () => {
    // Opening a window on a host whose operator did not ask for one is a side
    // effect nobody consented to, and on a shared or headless box it is worse
    // than useless.
    const { parsed, browser } = run(['pair', '--no-wait']);
    await parsed;
    browser.opened.should.be.empty();
  });

  it('hands the pairing link to this host when it is asked for', async () => {
    // The same-machine case: the daemon and the browser are one machine, so
    // there is nobody to scan anything.
    const { parsed, browser, qr } = run(['pair', '--open', '--no-wait']);
    await parsed;
    browser.opened.should.have.length(1);
    // The SAME link the QR carries — not a second opinion about where to go.
    browser.opened[0]?.should.equal(qr.requests[0]?.value);
  });
});
