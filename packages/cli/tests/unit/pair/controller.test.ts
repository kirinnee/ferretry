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
  bentMint,
  FixedTerminalSize,
  LOCAL_ONLY_MINT,
  LOCAL_PAIR_URL,
  MINT,
  MINTED_AT,
  NO_LINK_MINT,
  PAIR_URL,
  PAIRING_ID,
  pending,
  RecordingBrowserOpener,
  RecordingProgress,
  redeemed,
  DISCOVERED_RELAY_URL,
  RELAY_LOCAL_ONLY_MINT,
  RELAY_PAIR_URL,
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
  readonly browser: RecordingBrowserOpener;
}

function harness(overrides: Partial<PairDeps> = {}, gateway = new ScriptedPairGateway()): Harness {
  const screen = new CapturingScreen();
  const progress = new RecordingProgress();
  const exit = new CapturingExit();
  const clock = new FakeClock();
  const qr = new StubQrEncoder();
  const browser = new RecordingBrowserOpener();
  const deps: PairDeps = {
    gateway,
    screen,
    progress,
    exit,
    clock,
    qr,
    terminal: new FixedTerminalSize(100),
    browser,
    binaryName: 'fy',
    ...overrides,
  };
  return {
    subject: new PairController(deps),
    gateway,
    screen,
    progress,
    exit,
    clock,
    qr,
    browser: (deps.browser as RecordingBrowserOpener) ?? browser,
  };
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
    should(h.qr.requests[0]?.value).equal(PAIR_URL);
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

  it('should encode no QR for an address only this machine can dial, and still wait for it to be redeemed', async () => {
    // THE BLOCKER, AT THE COMMAND. A loopback advertisement is the DEFAULT, so this is not an error
    // path: the code is live, the link works for a browser here, and the one thing that must not
    // happen is a QR — a phone that reads it dials itself. Nothing here inspects the address: the
    // daemon said `local-only`, because the device that redeems this is not the one running this.
    const h = harness({}, new ScriptedPairGateway([redeemed()], LOCAL_ONLY_MINT));

    await pair(h);

    should(h.qr.requests).be.empty();
    should(h.screen.text).containEql('Only a browser on this machine can redeem this link');
    const flattened = h.screen.text.replace(/\s+/gu, ' ');
    should(flattened).containEql('publicUrl');
    should(flattened).containEql('to the address other devices reach this machine at');
    should(h.screen.text).containEql(CODE);
    // There is nothing to scan on this offer, so the live line must not say there is.
    should(h.progress.events[0]).equal('start:Waiting for the code to be redeemed — 2:00 left');
    // Still the whole command: it waited, and it reported the ending.
    should(h.gateway.polled).eql([PAIRING_ID]);
    should(h.progress.ending).containEql('Pixel is paired with workstation (127.0.0.1:7431)');
    should(h.exit.code).be.undefined();
  });

  it('should draw the QR for a local-only address that dials a discoverable rendezvous, and disclose it', async () => {
    // THE NARROWING THIS TASK ADDS. `reach: 'local-only'` still means the DIRECT address is dead on
    // another device, but a rendezvous the scanning device can DISCOVER for itself means a different
    // device can redeem this link anyway — so the QR belongs on screen, alongside the disclosure that
    // a rendezvous now sees this exchange's metadata.
    const h = harness({}, new ScriptedPairGateway([redeemed()], RELAY_LOCAL_ONLY_MINT));

    await pair(h);

    should(h.qr.requests).have.length(1);
    should(h.qr.requests[0]?.value).equal(RELAY_PAIR_URL);
    // The encoded link is the ordinary fragment: the disclosed address is beside the QR, not in it.
    should(h.qr.requests[0]?.value).not.containEql('relay');
    should(h.screen.text).containEql(DISCOVERED_RELAY_URL);
    should(h.screen.text).containEql('rendezvous');
    // Flattened, since the notice's own word wrap is not what this test is about.
    should(h.screen.text.replace(/\s+/gu, ' ')).containEql('metadata such as timing and sizes');
    // The live line must call it a scan: a QR is genuinely on this screen.
    should(h.progress.events[0]).equal('start:Waiting for the scan — 2:00 left');
    should(h.progress.ending).containEql('Pixel is paired with workstation (127.0.0.1:7431)');
    should(h.exit.code).be.undefined();
  });

  it('should still open a local-only link on this host, which is the one browser it is for', async () => {
    const h = harness({}, new ScriptedPairGateway([redeemed()], LOCAL_ONLY_MINT));

    await pair(h, { open: true });

    should(h.browser.opened).eql([LOCAL_PAIR_URL]);
    should(h.screen.text).containEql('Opened the pairing link in this host’s browser');
  });

  it('should draw nothing to scan when the daemon has no address, and say why without failing', async () => {
    // A wildcard bind hands out nothing. The mint still happened, so the code is real and the command
    // still watches it — refusing here would break a daemon that is serving perfectly.
    const h = harness({}, new ScriptedPairGateway([redeemed()], NO_LINK_MINT));

    await pair(h);

    should(h.qr.requests).be.empty();
    should(h.screen.text).containEql('binds every interface');
    should(h.screen.text).not.containEql('ferretry.pages.dev');
    should(h.screen.text).containEql(CODE);
    should(h.gateway.polled).eql([PAIRING_ID]);
    // A refusal has nothing to scan either, so the live line names what is actually happening.
    should(h.progress.events[0]).equal('start:Waiting for the code to be redeemed — 2:00 left');
    // No address was ever given, so the ending names the daemon and invents nothing.
    should(h.progress.ending).equal('succeed:Pixel is paired with workstation — it holds its own token now.');
  });

  it('should tell an operator who asked for --open that there was no link to open', async () => {
    const h = harness({}, new ScriptedPairGateway([expired], NO_LINK_MINT));

    await pair(h, { open: true });

    should(h.browser.opened).be.empty();
    should(h.screen.text).containEql('no link to open');
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
    const h = harness({}, new ScriptedPairGateway([pending], bentMint({ daemonUrl: 'https://box.ts.net/proxy' })));

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

describe('fy pair --open', () => {
  it('says the browser opened, and leaves the code on the screen anyway', async () => {
    const browser = new RecordingBrowserOpener(true);
    const h = harness({ browser });
    await pair(h, { open: true, wait: false });

    h.screen.text.should.match(/Opened the pairing link/);
    // The QR is NOT withdrawn. A reader who asked for --open on a machine that
    // also has a phone nearby may still prefer the phone; taking the code away
    // the moment a window opened would remove a choice for no reason.
    h.screen.text.should.match(/code/);
    browser.opened.should.have.length(1);
  });

  it('reports a host that cannot open one as a fact, not as a failure', async () => {
    // A headless box, an SSH session, a container, a desktop with no handler:
    // all ordinary places to run this. The code is untouched and the QR is
    // still above, so the honest line points at what still works.
    const browser = new RecordingBrowserOpener(false);
    const h = harness({ browser });
    await pair(h, { open: true, wait: false });

    const screen = h.screen.text;
    screen.should.match(/Could not open a browser/);
    screen.should.match(/untouched/);
    screen.should.match(/fy pair/);
    // Nothing about it is an error: the exit status belongs to the pairing.
    should.not.exist(h.exit.code);
  });
});
