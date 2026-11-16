import { describe, it } from 'bun:test';
import { CAPABILITY_NAMES, LIMITED_DEVICE_GRANTS } from '@ferretry/core-gate/contract';
import type { VerbInvocation } from '@ferretry/kernel/manifest';
import should from 'should';
import { overview, PAIR_OPTIONS_HELP, pairVerb } from '../../../../cli/lib/pair/commands.ts';
import { PairController, type PairDeps } from '../../../../cli/lib/pair/controller.ts';
import { ExitStatus } from '../../../../cli/shell.ts';
import {
  CapturingExit,
  CapturingScreen,
  expired,
  FakeClock,
  FixedTerminalSize,
  RecordingBrowserOpener,
  RecordingRedirectSweeper,
  RecordingProgress,
  ScriptedPairGateway,
  StubQrEncoder,
} from './fixtures';

/**
 * `fy pair <flags>` as the 5.0 shell's `parseArgs` splits them (`packages/cli/src/lib/argv.ts`): `--name` is `true`,
 * `--no-name` is `false`, `--name value` is a value. Copied small, since a plugin test does not import the shell.
 */
function parseArgs(tokens: readonly string[]): VerbInvocation {
  const args: string[] = [];
  const options: Record<string, string | boolean> = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    if (!token.startsWith('-')) {
      args.push(token);
      continue;
    }
    const body = token.replace(/^-{1,2}/u, '');
    const next = tokens[index + 1];
    if (body.startsWith('no-')) options[body.slice(3)] = false;
    else if (next !== undefined && !next.startsWith('-')) {
      options[body] = next;
      index += 1;
    } else options[body] = true;
  }
  return { args, options };
}

/** `fy pair <argv>`: the words split exactly as the 5.0 shell splits them, then handed to the verb. */
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
    redirectSweeper: new RecordingRedirectSweeper(),
    binaryName,
  };
  const errors: string[] = [];
  const verb = pairVerb(() => new PairController(deps), { err: text => errors.push(text) }, new ExitStatus());
  return { code: verb(parseArgs(argv)), errors, gateway, screen, qr, browser };
}

/** The help a shell would print for `fy pair --help`: the flags, then the overview. */
const help = (bin: string): string =>
  [...PAIR_OPTIONS_HELP.map(([flag, text]) => `${flag}  ${text}`), '', overview(bin)].join('\n');

describe('pair command surface', () => {
  it('should say nothing about a password, because minting needs none', () => {
    should(help('foo').toLowerCase()).not.containEql('password');
  });

  it('should pair with no flags at all', async () => {
    // Arrange + Act
    const { code, gateway } = run([]);
    await code;

    // Assert
    should(gateway.minted).equal(1);
  });

  it('should ask for a full-size QR under --large', async () => {
    // Arrange + Act
    const { code, qr } = run(['--large']);
    await code;

    // Assert
    should(qr.requests[0]?.size).equal('large');
  });

  it('should print and leave under --no-wait, polling nothing', async () => {
    // Arrange + Act
    const { code, gateway, screen } = run(['--no-wait']);

    // Assert
    should(await code).equal(0);
    should(screen.writes).have.length(1);
    should(gateway.polled).be.empty();
  });

  it('should offer no --name, because the device names itself when it redeems', async () => {
    // Arrange + Act — the daemon's mint is bodyless, so a host-side label has nowhere to go.
    const { code, errors, gateway } = run(['--name', 'Pixel']);

    // Assert
    should(await code).equal(1);
    should(errors).eql(["error: unknown option '--name'\n"]);
    should(gateway.minted).equal(0);
  });

  it('should offer no --json, because the only secret here is the code', async () => {
    // Arrange + Act
    const { code, errors, gateway } = run(['--json']);

    // Assert
    should(await code).equal(1);
    should(errors).eql(["error: unknown option '--json'\n"]);
    should(gateway.minted).equal(0);
  });
});

describe('pair --open', () => {
  it('is opt-in: the plain command opens nothing', async () => {
    // Opening a window on a host whose operator did not ask for one is a side
    // effect nobody consented to, and on a shared or headless box it is worse
    // than useless.
    const { code, browser } = run(['--no-wait']);
    await code;
    browser.opened.should.be.empty();
  });

  it('hands the pairing link to this host when it is asked for', async () => {
    // The same-machine case: the daemon and the browser are one machine, so
    // there is nobody to scan anything.
    const { code, browser, qr } = run(['--open', '--no-wait']);
    await code;
    browser.opened.should.have.length(1);
    // The SAME link the QR carries — not a second opinion about where to go.
    browser.opened[0]?.should.equal(qr.requests[0]?.value);
  });
});

describe('pair --limited', () => {
  it('should mint the full set unless asked', async () => {
    // Arrange + Act
    const { code, gateway } = run(['--no-wait']);
    await code;

    // Assert
    should(gateway.mintedWith).eql(['full']);
  });

  it('P39 should mint the limited set under --limited, which holds fleet.use and nothing else', async () => {
    // Arrange + Act
    const { code, gateway } = run(['--limited', '--no-wait']);
    await code;

    // Assert
    should(gateway.mintedWith).eql(['limited']);
    for (const capability of CAPABILITY_NAMES)
      should(LIMITED_DEVICE_GRANTS[capability]).eql({ use: capability === 'fleet', configure: false });
  });

  it('P46 should refuse the removed --full flag', async () => {
    // Arrange + Act
    const { code, errors, gateway } = run(['--full', '--no-wait']);

    // Assert
    should(await code).equal(1);
    should(errors).eql(["error: unknown option '--full'\n"]);
    should(gateway.minted).equal(0);
  });

  it('should say a device can do anything behind its unlock, what --limited does, and name the binary it runs as', () => {
    // Arrange + Act
    const text = help('foo').replace(/\s+/gu, ' ');

    // Assert
    should(text).containEql('--limited');
    should(text).containEql('can do anything on this machine');
    should(text).containEql('unlocks it with its passkey');
    should(text).containEql('read the fleet and chat with sessions');
    should(text).containEql('`foo device grant`');
    should(text).not.containEql('--full');
    should(text).not.match(/\bfy device/u);
  });
});
