import { describe, it } from 'bun:test';
import should from 'should';
import {
  PAIR_POLL_INTERVAL_MS,
  type PairDeps,
  PairController,
  type PairOptions,
} from '../../../src/lib/pair/controller';
import {
  CapturingExit,
  CapturingScreen,
  CODE,
  expired,
  FakeClock,
  FixedTerminalSize,
  MINT,
  MINTED_AT,
  PAIRING_ID,
  pending,
  RecordingProgress,
  redeemed,
  ScriptedPairGateway,
  StubQrEncoder,
} from './fixtures';

interface Harness {
  readonly subject: PairController;
  readonly gateway: ScriptedPairGateway;
  readonly screen: CapturingScreen;
  readonly progress: RecordingProgress;
  readonly exit: CapturingExit;
  readonly clock: FakeClock;
  readonly qr: StubQrEncoder;
}

function harness(overrides: Partial<PairDeps> = {}, gateway = new ScriptedPairGateway()): Harness {
  const screen = new CapturingScreen();
  const progress = new RecordingProgress();
  const exit = new CapturingExit();
  const clock = new FakeClock();
  const qr = new StubQrEncoder();
  const deps: PairDeps = {
    gateway,
    screen,
    progress,
    exit,
    clock,
    qr,
    terminal: new FixedTerminalSize(100),
    binaryName: 'fy',
    ...overrides,
  };
  return { subject: new PairController(deps), gateway, screen, progress, exit, clock, qr };
}

const pair = async (h: Harness, options: PairOptions = {}): Promise<void> => {
  await h.subject.pair(options);
};

describe('fy pair', () => {
  it('should mint bodylessly, draw the daemon-minted link, and ask about it by pairing id', async () => {
    // Arrange
    const gateway = new ScriptedPairGateway([redeemed()]);
    const h = harness({}, gateway);

    // Act
    await pair(h);

    // Assert
    should(gateway.minted).equal(1);
    // The code never addresses anything: the poll carries the pairing id and nothing else.
    should(gateway.polled).eql([PAIRING_ID]);
    should(h.screen.text).containEql(CODE);
    should(h.qr.requests[0]?.value).equal(MINT.pairUrl);
    should(h.qr.requests[0]?.size).equal('compact');
    should(h.progress.ending).equal(
      'succeed:Pixel is paired with workstation (box.tailnet-abc.ts.net) — it holds its own token now.',
    );
    should(h.exit.code).be.undefined();
  });

  it('should print the name the DEVICE chose, since the host never supplies one', async () => {
    // Arrange
    const h = harness({}, new ScriptedPairGateway([redeemed("Kirin's phone")]));

    // Act
    await pair(h);

    // Assert
    should(h.progress.ending).containEql("Kirin's phone is paired with");
  });

  it('should draw a full-size QR only when asked', async () => {
    // Arrange
    const h = harness({}, new ScriptedPairGateway([expired]));

    // Act
    await pair(h, { large: true });

    // Assert
    should(h.qr.requests[0]?.size).equal('large');
  });

  it('should count the code down once a second and stop the moment it is redeemed', async () => {
    // Arrange — pending for two ticks, then redeemed.
    const gateway = new ScriptedPairGateway([pending, pending, redeemed()]);
    const h = harness({}, gateway);

    // Act
    await pair(h);

    // Assert
    should(h.progress.events.slice(0, 3)).eql([
      'start:Waiting for the scan — 2:00 left',
      'start:Waiting for the scan — 1:59 left',
      'start:Waiting for the scan — 1:58 left',
    ]);
    should(h.clock.slept).eql([PAIR_POLL_INTERVAL_MS, PAIR_POLL_INTERVAL_MS]);
    should(gateway.polled).have.length(3);
  });

  it('should report a code nobody used, and exit non-zero because pairing did not happen', async () => {
    // Arrange
    const h = harness({}, new ScriptedPairGateway([pending, expired]));

    // Act
    await pair(h);

    // Assert
    should(h.progress.ending).equal('fail:The code expired unused. Run `fy pair` for a new one.');
    should(h.exit.code).equal(1);
  });

  it('should report expiry once the deadline passes even while the daemon still says pending', async () => {
    // Arrange — a daemon that never changes its answer; the clock is what ends the wait.
    const h = harness({}, new ScriptedPairGateway([pending]));

    // Act
    await pair(h);

    // Assert
    should(h.gateway.polled).have.length(120);
    should(h.progress.ending).equal('fail:The code expired unused. Run `fy pair` for a new one.');
    should(h.exit.code).equal(1);
  });

  it('should refuse to call an unreachable daemon an unused code', async () => {
    // Arrange — the daemon stops answering and never comes back.
    const h = harness({}, new ScriptedPairGateway([pending, new Error('fetch failed')]));

    // Act
    await pair(h);

    // Assert — damaged state is not empty state: this is the third ending, not the second.
    should(h.progress.ending).startWith(
      'fail:The code has expired and whether anything used it is unknown: fetch failed',
    );
    should(h.progress.ending).not.containEql('expired unused');
    should(h.exit.code).equal(1);
  });

  it('should clear the doubt when the daemon answers again before the deadline', async () => {
    // Arrange — one failure, then a definite answer.
    const h = harness({}, new ScriptedPairGateway([new Error('connection reset'), pending, expired]));

    // Act
    await pair(h);

    // Assert — a recovered daemon means the ordinary ending, not the unknown one.
    should(h.progress.ending).equal('fail:The code expired unused. Run `fy pair` for a new one.');
  });

  it('should print the screen and leave under --no-wait, with nothing polled', async () => {
    // Arrange
    const h = harness();

    // Act
    await pair(h, { wait: false });

    // Assert
    should(h.screen.writes).have.length(1);
    should(h.gateway.polled).be.empty();
    should(h.progress.events).be.empty();
    should(h.exit.code).be.undefined();
  });

  it('should refuse a mint that is already dead instead of drawing a QR for it', async () => {
    // Arrange — the clock is past the stated expiry.
    const h = harness({ clock: new FakeClock(Date.parse(MINT.expiresAt)) });

    // Act + Assert
    await should(h.subject.pair({})).be.rejectedWith(
      'the daemon minted a code that has already expired — check the clock on this host',
    );
    should(h.screen.writes).be.empty();
  });

  it('should refuse a mint that outlives the pairing window, rather than help publish it', async () => {
    // Arrange — the code claims to live far longer than the design allows.
    const h = harness({ clock: new FakeClock(MINTED_AT - 10 * 60 * 1_000) });

    // Act + Assert
    await should(h.subject.pair({})).be.rejectedWith(/outlives the 120s pairing window/u);
    should(h.screen.writes).be.empty();
  });

  it('should refuse a link the phone would reject, before it becomes a QR', async () => {
    // Arrange — a daemon whose own address carries a reverse-proxy path; the mint schema allows it,
    // the PWA's reader does not.
    const h = harness({}, new ScriptedPairGateway([pending], { ...MINT, daemonUrl: 'https://box.ts.net/proxy' }));

    // Act + Assert
    await should(h.subject.pair({})).be.rejectedWith('daemon URL must be an origin without a path');
    should(h.screen.writes).be.empty();
    should(h.qr.requests).be.empty();
  });

  it('should let a mint failure surface, so no screen claims a code that was never issued', async () => {
    // Arrange
    const h = harness({}, new ScriptedPairGateway([pending], new Error('host-local access required')));

    // Act + Assert
    await should(h.subject.pair({})).be.rejectedWith('host-local access required');
    should(h.screen.writes).be.empty();
  });

  it('should pass the terminal width through, so a narrow window withholds the QR', async () => {
    // Arrange
    const h = harness(
      { terminal: new FixedTerminalSize(20), qr: new StubQrEncoder('█'.repeat(30)) },
      new ScriptedPairGateway([expired]),
    );

    // Act
    await pair(h);

    // Assert
    should(h.screen.text).containEql('it is not drawn');
  });
});
