import { describe, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import should from 'should';
import {
  ComposerOccupiedError,
  ComposerUnconfirmedError,
  PaneDeliveryError,
  PaneStrandedError,
  TmuxPaneDelivery,
} from '../../../src/adapters/index.ts';
import { TmuxController } from '../../../src/lib/index.ts';
import { FakeTmuxServer } from '../support/fake-tmux-server.ts';
import { loadRecording, RecordedPane } from '../support/recorded-pane.ts';

const SESSION = 'fy-session-1';

/** No real waiting: every sleep moves the fake's virtual clock instead, which is all a stalled pane reads. */
function delivery(server: FakeTmuxServer | RecordedPane, options = {}) {
  const slept: number[] = [];
  const subject = new TmuxPaneDelivery(
    new TmuxController(server),
    async milliseconds => {
      slept.push(milliseconds);
      server.advance(milliseconds);
    },
    options,
  );
  return { subject, slept };
}

const literals = (server: FakeTmuxServer): number => server.calls.filter(call => call.includes('-l')).length;
const enters = (server: FakeTmuxServer): number => server.calls.filter(call => call.at(-1) === 'Enter').length;

describe('tmux pane delivery — readiness', () => {
  it('should answer the trust prompt a first launch in a new directory always shows', async () => {
    // Arrange — the modal renders a prompt line under it, which is what used to read as ready.
    const server = new FakeTmuxServer();
    server.modal = 'Do you trust the files in this folder?\n❯ 1. Yes, proceed\n  2. No, exit';
    const { subject } = delivery(server);

    // Act
    await subject.waitReady(SESSION);

    // Assert
    should(server.calls.filter(call => call[0] === 'send-keys')).deepEqual(
      [['send-keys', '-t', SESSION, 'Enter']],
      'the affirmative row is already selected, so one Enter answers it',
    );
  });

  it("should answer Claude 2.1.281's folder-trust screen, whose first option is `No, exit`, with Down then Enter", async () => {
    // Arrange — the screen as it draws: no numbers, the cursor on the option that ends the session.
    const server = new FakeTmuxServer();
    server.modal = (
      await readFile(join(import.meta.dir, '../../fixtures/startup-dialogs/claude-2.1.281-folder-trust.txt'), 'utf8')
    ).trimEnd();
    const { subject } = delivery(server);

    // Act
    await subject.waitReady(SESSION);

    // Assert — it was a dialog to answer, never a draft to refuse, and never `No, exit` by Enter alone.
    const keys = server.calls.filter(call => call[0] === 'send-keys').map(call => call.at(-1));
    should(keys).deepEqual(['Down', 'Enter']);
  });

  it("should answer Claude's auto-mode dialog NO, keeping the mode the owner chose, then deliver", async () => {
    // Arrange — the dialog that parked a bypass agent with every message failing, cursor on Yes.
    const server = new FakeTmuxServer();
    server.modal = [
      ' Make auto mode your default permission mode?',
      '',
      '   ❯ Yes, set auto mode as my default permission mode',
      '     No, keep bypass permissions',
    ].join('\n');
    const { subject } = delivery(server);

    // Act
    await subject.deliver(SESSION, 'continue');

    // Assert — one step down to No, then Enter; never Enter on the highlighted Yes.
    const keys = server.calls.filter(call => call[0] === 'send-keys' && !call.includes('-l')).map(call => call.at(-1));
    should(keys.slice(0, 2)).deepEqual(['Down', 'Enter']);
    should(server.submitted).deepEqual(['continue']);
  });

  it('should name the dialog when one it cannot answer keeps the pane from ever being ready', async () => {
    // Arrange — a dialog with no safe answer to read off the screen.
    const server = new FakeTmuxServer();
    server.modal = 'Try the new fullscreen renderer?\n  Yes, try it   Not now';
    const { subject } = delivery(server, { readinessAttempts: 2 });

    // Act / Assert
    await should(subject.waitReady(SESSION)).be.rejectedWith(
      /blocked by a prompt on screen: "Try the new fullscreen renderer\?" — answer it in the terminal/u,
    );
    should(server.calls.some(call => call[0] === 'send-keys')).be.false();
  });

  it("should name Codex's hooks-review dialog when it keeps the pane from ever being ready", async () => {
    // Arrange — the pane Codex 0.156.1 really drew, which no startup rule answers on the person's behalf.
    const frame = await readFile(
      join(import.meta.dir, '../../fixtures/harness-dialogs/codex-0.156.1-hooks-review.txt'),
      'utf8',
    );
    // The fake draws a composer under every modal; a real dialog owns the whole screen, footer last.
    const server = new (class extends FakeTmuxServer {
      override async execute(argv: readonly string[], stdin?: string) {
        return argv[0] === 'capture-pane' ? { code: 0, stdout: frame, stderr: '' } : await super.execute(argv, stdin);
      }
    })();
    const { subject } = delivery(server, { readinessAttempts: 2 });

    // Act / Assert
    await should(subject.waitReady(SESSION)).be.rejectedWith(/Harness dialog — Hooks need review/u);
    should(server.calls.some(call => call[0] === 'send-keys')).be.false();
  });

  it('should walk the resume menu to the configured row rather than pressing Enter on the default', async () => {
    // Arrange — Claude Code's large-session gate, cursor on row 1.
    const server = new FakeTmuxServer();
    server.modal = [
      'This session is 2h 45m old and 382k tokens.',
      '❯ 1. Resume from summary (recommended)',
      '  2. Resume full session as-is',
      "  3. Don't ask me again",
    ].join('\n');
    const { subject } = delivery(server);

    // Act
    await subject.waitReady(SESSION, { resumeMenuChoice: 'full' });

    // Assert
    should(server.calls.filter(call => call[0] === 'send-keys').map(call => call.at(-1))).deepEqual(
      ['Down', 'Enter'],
      'row 2 is one step below the highlighted row; option 3 must never be reachable',
    );
  });

  it('should stop rather than keep answering a dialog its keys are not clearing', async () => {
    // Arrange — a modal that comes straight back after every answer.
    const server = new FakeTmuxServer();
    server.modal = 'Do you trust the files in this folder?\n❯ 1. Yes, proceed\n  2. No, exit';
    server.modalsToClear = 0;
    const { subject } = delivery(server);

    // Act / Assert
    await should(subject.waitReady(SESSION)).be.rejectedWith(/claude-trust dialog did not close after 3 attempts/u);
    should(server.calls.filter(call => call[0] === 'send-keys')).have.length(3);
  });

  it('should wait out a booting harness and give up rather than type into it', async () => {
    // Arrange
    const booting = new FakeTmuxServer();
    booting.bootCaptures = 4;
    const wedged = new FakeTmuxServer();
    wedged.bootCaptures = Number.MAX_SAFE_INTEGER;

    // Act
    await delivery(booting).subject.waitReady(SESSION);
    const waited = delivery(wedged, { readinessAttempts: 2 });

    // Assert
    await should(waited.subject.waitReady(SESSION)).be.rejectedWith(/did not become ready to accept a turn/u);
    should(waited.slept).deepEqual([100, 200]);
    should(wedged.calls.some(call => call[0] === 'send-keys')).be.false();
  });

  it('should refuse a pane whose harness has exited, and say what tmux reported', async () => {
    // Arrange
    const gone = new FakeTmuxServer();
    gone.alive = false;
    const died = new FakeTmuxServer();
    died.dead = true;
    died.exitCode = '137';

    // Act / Assert
    await should(delivery(gone).subject.waitReady(SESSION)).be.rejectedWith(/exited; tmux reported no exit code/u);
    await should(delivery(died).subject.waitReady(SESSION)).be.rejectedWith(/exited \(137\)/u);
  });
});

describe('tmux pane delivery — landing proof', () => {
  it('should admit a durable effect after readiness but before the first composer write', async () => {
    // Arrange — the first two frames are boot frames, so an early callback would spend a turn that
    // never touched the TUI. Once it runs, no literal or paste write may have happened yet.
    const server = new FakeTmuxServer();
    server.bootCaptures = 2;
    const { subject } = delivery(server);
    let admitted = 0;

    // Act
    await subject.deliver(SESSION, 'continue', {}, async () => {
      admitted += 1;
      should(server.calls.some(call => call.includes('-l') || call[0] === 'load-buffer')).be.false();
      should(server.calls.filter(call => call[0] === 'capture-pane')).not.be.empty();
    });

    // Assert
    should(admitted).equal(1);
    should(server.submitted).deepEqual(['continue']);
  });

  it('should type a short single-line turn literally and submit it once it is proven on screen', async () => {
    // Arrange
    const server = new FakeTmuxServer();
    const { subject } = delivery(server);

    // Act
    const actual = await subject.deliver(SESSION, 'continue');

    // Assert
    should(actual).equal('turn-started');
    should(server.submitted).deepEqual(['continue']);
    should(server.calls.filter(call => call.includes('-l'))).deepEqual([
      ['send-keys', '-t', SESSION, '-l', 'continue'],
    ]);
  });

  it('should send a multi-line turn as one bracketed paste and accept the placeholder as proof', async () => {
    // Arrange — the payload the harness collapses and renders NONE of.
    const server = new FakeTmuxServer();
    const brief = 'Read the file /turns/turn-001.md now,\nthen follow every instruction inside it.';
    const { subject } = delivery(server);

    // Act
    const actual = await subject.deliver(SESSION, brief);

    // Assert
    should(actual).equal('turn-started');
    should(server.submitted).deepEqual([brief], 'the pane received the whole brief as one message');
    should(server.commands()).containEql('load-buffer');
    should(server.calls.some(call => call[0] === 'paste-buffer' && call.includes('-p'))).be.true();
    should(server.heldBuffers()).deepEqual([], 'a delivered paste leaves no payload in the tmux server');
  });

  it('should report a slash command the TUI handled itself as delivered, not as a failure', async () => {
    // Arrange
    const server = new FakeTmuxServer();
    server.localCommand = true;
    const { subject } = delivery(server);

    // Act
    const actual = await subject.deliver(SESSION, '/status');

    // Assert
    should(actual).equal('handled-local');
    should(server.submitted).deepEqual(['/status']);
  });

  it('should call a payload no frame ever showed unconfirmed, typed once, with no Enter on a guess', async () => {
    // Arrange — a pane that takes every keystroke and draws nothing, ever: it may be reading them yet.
    const server = new FakeTmuxServer();
    server.execute = async argv => {
      server.calls.push(argv);
      if (argv[0] === 'has-session') return { code: 0, stdout: '', stderr: '' };
      if (argv[0] === 'display-message') return { code: 0, stdout: '0||2|1|24|80\n', stderr: '' };
      if (argv[0] === 'capture-pane') return { code: 0, stdout: 'the last frame\n> \n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    const { subject, slept } = delivery(server);

    // Act
    const refused = await subject.deliver(SESSION, 'continue').catch((error: unknown) => error);

    // Assert — the whole stalled window was given, then the composer was left exactly as it was.
    should(refused).be.instanceof(ComposerUnconfirmedError);
    should((refused as ComposerUnconfirmedError).message).match(/drew nothing for 12 s; it may still be reading it/u);
    should((refused as ComposerUnconfirmedError).typings).equal(1);
    should(literals(server)).equal(1, 'an empty composer on a pane that drew nothing proves nothing');
    should(enters(server)).equal(0, 'Enter is never pressed on a guess');
    should(slept.reduce((sum, wait) => sum + wait, 0)).equal(12_000);
  });

  it('should type a send ONCE by default, even when a live pane drew an empty composer after it', async () => {
    // Arrange — the shape a second fill would trust: the pane drew, and the composer reads empty. On the
    // owner's Mac exactly that reading was wrong, and one message was typed three times.
    const server = new FakeTmuxServer();
    const underlying = server.execute.bind(server);
    server.execute = async (argv, stdin) => {
      if (argv.includes('-l')) {
        server.calls.push(argv);
        server.transcript = 'the last frame\n⎿ a status line ticked';
        return { code: 0, stdout: '', stderr: '' };
      }
      return await underlying(argv, stdin);
    };
    const { subject } = delivery(server);

    // Act
    const refused = await subject.deliver(SESSION, 'continue').catch((error: unknown) => error);

    // Assert
    should(refused).be.instanceof(ComposerUnconfirmedError);
    should((refused as ComposerUnconfirmedError).message).match(
      /drew an empty composer after it; it was not typed again/u,
    );
    should(literals(server)).equal(1, 'only a person, with a forced retry, types it into this pane again');
  });

  it("should type ONCE into a stalled pane showing a ghost suggestion — the owner's triple message", async () => {
    // Arrange — the Mac: Claude's dim suggestion of the next prompt sat in the composer with the cursor at
    // its first column (an EMPTY composer, rightly), and the pane did not read the keys for seconds, so
    // every look still showed the suggestion. The old fill typed again at each look's end: three copies.
    const late = new FakeTmuxServer();
    late.placeholder = 'go ahead with all three';
    late.stalledUntilMs = 9_000;
    const never = new FakeTmuxServer();
    never.placeholder = 'go ahead with all three';
    never.stalledUntilMs = 60_000;

    // Act
    await delivery(late).subject.deliver(SESSION, "what's the status thusfar?");
    const refused = await delivery(never)
      .subject.deliver(SESSION, "what's the status thusfar?")
      .catch((error: unknown) => error);
    never.advance(60_000);

    // Assert — landed once when it woke; unconfirmed, and still one copy, when it never did in time.
    should(late.submitted).deepEqual(["what's the status thusfar?"]);
    should(literals(late)).equal(1);
    should(refused).be.instanceof(ComposerUnconfirmedError);
    should(literals(never)).equal(1);
    should(never.composer).equal("what's the status thusfar?");
  });

  it('should type again only when a pane that visibly drew still shows an empty composer, if allowed two fills', async () => {
    // Arrange — the first literal is dropped by a LIVE pane: it draws (a status line ticks) and its
    // composer stays empty, which is the one shape that proves the keys never arrived.
    const server = new FakeTmuxServer();
    let typed = 0;
    const underlying = server.execute.bind(server);
    server.execute = async (argv, stdin) => {
      if (argv.includes('-l')) {
        typed += 1;
        if (typed === 1) {
          server.calls.push(argv);
          server.transcript = 'the last frame\n⎿ a status line ticked';
          return { code: 0, stdout: '', stderr: '' };
        }
      }
      return await underlying(argv, stdin);
    };
    const { subject } = delivery(server, { composerAttempts: 2 });

    // Act
    const actual = await subject.deliver(SESSION, 'continue');

    // Assert
    should(actual).equal('turn-started');
    should(server.calls.filter(call => call.at(-1) === 'C-u')).be.empty();
    should(typed).equal(2, 'the pane drew and still showed an empty composer, so one more fill was safe');
    should(server.submitted).deepEqual(['continue']);
  });

  it('should stop after the second fill a live pane also dropped, and say it was typed twice', async () => {
    // Arrange — every literal is dropped, and the pane draws after each one.
    const server = new FakeTmuxServer();
    const underlying = server.execute.bind(server);
    server.execute = async (argv, stdin) => {
      if (argv.includes('-l')) {
        server.calls.push(argv);
        server.transcript = `${server.transcript}\n⎿ tick`;
        return { code: 0, stdout: '', stderr: '' };
      }
      return await underlying(argv, stdin);
    };
    const { subject } = delivery(server, { composerAttempts: 2 });

    // Act
    const refused = await subject.deliver(SESSION, 'continue').catch((error: unknown) => error);

    // Assert
    should(refused).be.instanceof(ComposerUnconfirmedError);
    should((refused as ComposerUnconfirmedError).typings).equal(2);
    should((refused as ComposerUnconfirmedError).message).match(/2 times and the pane dropped it every time/u);
    should(enters(server)).equal(0);
  });

  it('should keep pressing Enter while the payload is visibly stuck, then refuse', async () => {
    // Arrange — a composer that holds text no matter what Enter does.
    const server = new FakeTmuxServer();
    const underlying = server.execute.bind(server);
    server.execute = async (argv, stdin) => {
      if (argv[0] === 'send-keys' && argv.at(-1) === 'Enter') {
        server.calls.push(argv);
        return { code: 0, stdout: '', stderr: '' };
      }
      return await underlying(argv, stdin);
    };
    const { subject } = delivery(server, { submitAttempts: 2, submitPolls: 1 });

    // Act / Assert
    await should(subject.deliver(SESSION, 'continue')).be.rejectedWith(/landed but stayed in the composer/u);
    should(server.calls.filter(call => call.at(-1) === 'Enter')).have.length(2);
  });
});

describe('tmux pane delivery — the ink of the composer', () => {
  const inkCaptures = (server: FakeTmuxServer) =>
    server.calls.filter(call => call[0] === 'capture-pane' && call.includes('-e'));

  it('should refuse a draft whose cursor is back at col 2, because its words are plain, not dim', async () => {
    // Arrange — the ghost suggestion's twin: a person typed the same words and pressed Home.
    const server = new FakeTmuxServer();
    server.composer = 'go ahead with all three';
    server.cursorHome = true;
    const { subject } = delivery(server);

    // Act
    const refused = await subject.deliver(SESSION, 'hello').catch((error: unknown) => error);

    // Assert — nothing typed onto the person's words.
    should(refused).be.instanceof(ComposerOccupiedError);
    should((refused as ComposerOccupiedError).draft).equal('go ahead with all three');
    should(literals(server)).equal(0);
  });

  it('should read the same cursor over a dim ghost suggestion as empty, and type once', async () => {
    // Arrange
    const server = new FakeTmuxServer();
    server.placeholder = 'go ahead with all three';
    const { subject } = delivery(server);

    // Act
    await subject.deliver(SESSION, 'hello');

    // Assert
    should(server.submitted).deepEqual(['hello']);
    should(literals(server)).equal(1);
  });

  it('should capture only the composer row with attributes, never the whole screen', async () => {
    // Arrange
    const server = new FakeTmuxServer();
    server.placeholder = 'go ahead with all three';
    const { subject } = delivery(server);

    // Act
    await subject.waitReady(SESSION);

    // Assert — one row, `-S` equal to `-E`, and always a plain capture beside it.
    const rows = inkCaptures(server);
    should(rows.length).be.above(0);
    for (const call of rows) should(call[call.indexOf('-S') + 1]).equal(call[call.indexOf('-E') + 1]);
    should(server.calls.some(call => call[0] === 'capture-pane' && !call.includes('-e'))).be.true();
  });

  it('should fall back to the cursor when the harness drew no attributes at all', async () => {
    // Arrange — started without a colour terminal: a ghost suggestion and a draft look alike, and the
    // cursor rule that stood before the ink is what still decides.
    const ghost = new FakeTmuxServer();
    ghost.placeholder = 'go ahead with all three';
    ghost.attributes = false;
    const draft = new FakeTmuxServer();
    draft.composer = 'go ahead with all three';
    draft.attributes = false;

    // Act
    await delivery(ghost).subject.deliver(SESSION, 'hello');
    const refused = await delivery(draft)
      .subject.deliver(SESSION, 'hello')
      .catch((error: unknown) => error);

    // Assert
    should(ghost.submitted).deepEqual(['hello']);
    should(refused).be.instanceof(ComposerOccupiedError);
  });

  it('should keep a payload typed once and unconfirmed when the ink is unreadable and the pane stalls', async () => {
    // Arrange — #756's invariant with no attributes available: a frozen pane gets one copy, not three.
    const server = new FakeTmuxServer();
    server.placeholder = 'go ahead with all three';
    server.attributes = false;
    server.stalledUntilMs = 60_000;
    const { subject } = delivery(server);

    // Act
    const refused = await subject.deliver(SESSION, 'hello').catch((error: unknown) => error);

    // Assert
    should(refused).be.instanceof(ComposerUnconfirmedError);
    should(literals(server)).equal(1);
  });
});

describe('tmux pane delivery — a stalled pane', () => {
  it('should land a recorded slow echo on its first typing and submit it once', async () => {
    // Arrange — Claude Code 2.1.281 frozen by its host: the echo took 2.5 s and the Enter 4 s more. The
    // old fill looked for 1.5 s, read the still-empty composer as dropped keys, and typed again.
    const recording = await loadRecording('claude-2.1.281-stalled-echo.json');
    const pane = new RecordedPane(recording);
    const { subject } = delivery(pane);

    // Act
    await subject.deliver(SESSION, recording.payload);

    // Assert
    should(pane.typings()).equal(1, 'one message, typed once');
    should(pane.enters()).equal(
      1,
      'the pane drew nothing after the Enter until it took it, so it was not pressed again',
    );
  });

  it('should leave the recorded slow echo unconfirmed rather than retype it, when the window is too short', async () => {
    // Arrange — the same recording under the old 1.5 s budget: what used to become a second copy.
    const recording = await loadRecording('claude-2.1.281-stalled-echo.json');
    const pane = new RecordedPane(recording);
    const { subject } = delivery(pane, { windowMs: 1_000, stalledWindowMs: 1_500, settleMs: 0 });

    // Act / Assert
    await should(subject.deliver(SESSION, recording.payload)).be.rejectedWith(ComposerUnconfirmedError);
    should(pane.typings()).equal(
      1,
      'the composer read empty because the pane had not read the keys — never a second copy',
    );
    should(pane.enters()).equal(0);
  });

  it('should wait out a pane frozen for 9 s and deliver exactly one copy', async () => {
    // Arrange
    const server = new FakeTmuxServer();
    server.stalledUntilMs = 9_000;
    const { subject } = delivery(server);

    // Act
    await subject.deliver(SESSION, 'continue');

    // Assert
    should(server.submitted).deepEqual(['continue']);
    should(literals(server)).equal(1);
    should(enters(server)).equal(1);
  });

  it('should wait out a frozen pane for a collapsed paste too, and land it on its placeholder', async () => {
    // Arrange
    const server = new FakeTmuxServer();
    server.stalledUntilMs = 5_000;
    const brief = 'Read the file /turns/turn-002.md now,\nthen follow every instruction inside it.';
    const { subject } = delivery(server);

    // Act
    await subject.deliver(SESSION, brief);

    // Assert
    should(server.submitted).deepEqual([brief]);
    should(server.calls.filter(call => call[0] === 'paste-buffer')).have.length(1);
  });

  it('should call a pane frozen past the ceiling unconfirmed, and leave one copy for when it wakes', async () => {
    // Arrange
    const server = new FakeTmuxServer();
    server.stalledUntilMs = 20_000;
    const { subject } = delivery(server);

    // Act
    const refused = await subject.deliver(SESSION, 'continue').catch((error: unknown) => error);
    server.advance(20_000);

    // Assert — the copy the frozen pane reads on waking is the only one there is, and it is not submitted.
    should(refused).be.instanceof(ComposerUnconfirmedError);
    should(literals(server)).equal(1);
    should(enters(server)).equal(0);
    should(server.composer).equal('continue');
    should(server.submitted).be.empty();
  });

  it('should land on a Mac-like host where every capture costs half a second and the pane is slow too', async () => {
    // Arrange — the owner's Mac: a pane capture takes 0.2–0.6 s, and the harness took 4 s to echo.
    const server = new (class extends FakeTmuxServer {
      override async execute(argv: readonly string[], stdin?: string) {
        if (argv[0] === 'capture-pane') this.advance(500);
        return await super.execute(argv, stdin);
      }
    })();
    server.stalledUntilMs = 4_000;
    const { subject } = delivery(server);

    // Act
    await subject.deliver(SESSION, 'continue');

    // Assert
    should(server.submitted).deepEqual(['continue']);
    should(literals(server)).equal(1);
  });

  it('should read at least five fresh frames however short the configured window is', async () => {
    // Arrange — a window shorter than one look, at a pane that echoes after 400 ms.
    const server = new FakeTmuxServer();
    server.stalledUntilMs = 400;
    const { subject } = delivery(server, { windowMs: 50, stalledWindowMs: 50, settleMs: 0 });

    // Act
    await subject.deliver(SESSION, 'continue');

    // Assert
    should(server.submitted).deepEqual(['continue']);
    should(literals(server)).equal(1);
  });

  it('should not press Enter again while a pane that froze after the echo has drawn nothing', async () => {
    // Arrange — the echo lands, then the host freezes for 5 s right as Enter is pressed.
    const server = new (class extends FakeTmuxServer {
      private froze = false;
      override async execute(argv: readonly string[], stdin?: string) {
        if (!this.froze && argv[0] === 'send-keys' && argv.at(-1) === 'Enter') {
          this.froze = true;
          this.stalledUntilMs = this.nowMs + 5_000;
        }
        return await super.execute(argv, stdin);
      }
    })();
    const { subject } = delivery(server);

    // Act
    await subject.deliver(SESSION, 'continue');

    // Assert
    should(server.submitted).deepEqual(['continue']);
    should(enters(server)).equal(1, 'a second Enter would only have queued behind the first');
  });
});

describe('tmux paste buffers', () => {
  it('should refuse an empty paste and leave no buffer behind when the paste itself fails', async () => {
    // Arrange
    const server = new FakeTmuxServer();
    const failing = new FakeTmuxServer();
    const underlying = failing.execute.bind(failing);
    failing.execute = async (argv, stdin) => {
      if (argv[0] === 'paste-buffer') {
        failing.calls.push(argv);
        return { code: 1, stdout: '', stderr: 'no client' };
      }
      return await underlying(argv, stdin);
    };
    const controller = new TmuxController(server);

    // Act / Assert
    await should(controller.paste(SESSION, '')).be.rejectedWith('paste text must not be empty');
    await should(new TmuxController(failing).paste(SESSION, 'a\nb')).be.rejectedWith('no client');
    should(failing.heldBuffers()).deepEqual([], 'a failed paste must not leave the payload in the server');
    should(new PaneDeliveryError('x').name).equal('PaneDeliveryError');
  });

  it('should surface a load failure rather than pasting a buffer it never filled', async () => {
    // Arrange
    const server = new FakeTmuxServer();
    const underlying = server.execute.bind(server);
    server.execute = async (argv, stdin) => {
      if (argv[0] === 'load-buffer') {
        server.calls.push(argv);
        return { code: 1, stdout: '', stderr: 'buffer too large' };
      }
      return await underlying(argv, stdin);
    };

    // Act / Assert
    await should(new TmuxController(server).paste(SESSION, 'a\nb')).be.rejectedWith('buffer too large');
    should(server.commands()).not.containEql('paste-buffer');
  });
});

describe('tmux pane delivery — the Codex composer', () => {
  it('should land `hi` first time over a placeholder that contains it, and submit it', async () => {
    // Arrange — the bug: `Ask Codex to do anything` holds a `hi`, so typing `hi` left a whole-frame
    // count unchanged and the daemon cleared and retyped until it gave up with `hi` stranded.
    const server = new FakeTmuxServer();
    server.placeholder = 'Ask Codex to do anything';
    const { subject } = delivery(server);

    // Act
    await subject.deliver(SESSION, 'hi');

    // Assert
    should(server.submitted).deepEqual(['hi']);
    should(server.calls.filter(call => call[0] === 'send-keys' && call.includes('-l'))).have.length(1);
    should(server.calls.some(call => call.at(-1) === 'C-u')).be.false();
  });

  it('should press Enter again when the first one only opened a new line, and submit once', async () => {
    // Arrange — Codex 0.156.1 turns an Enter inside its paste-burst window into a newline.
    const server = new FakeTmuxServer();
    server.placeholder = 'Ask Codex to do anything';
    server.swallowEnters = 1;
    const { subject } = delivery(server);

    // Act
    await subject.deliver(SESSION, 'hello');

    // Assert
    should(server.submitted).deepEqual(['hello']);
    should(server.calls.filter(call => call.at(-1) === 'Enter')).have.length(2);
  });

  it('should say a payload that every Enter left in the composer is typed and not sent', async () => {
    const server = new FakeTmuxServer();
    server.swallowEnters = Number.MAX_SAFE_INTEGER;
    const { subject } = delivery(server, { submitPolls: 1 });

    await should(subject.deliver(SESSION, 'hi')).be.rejectedWith(PaneStrandedError);
    should(server.submitted).be.empty();
  });

  it('should type nothing into a composer that already holds a draft, and say so without the long wait', async () => {
    // Arrange — `hi` sits there unsent; typing `hello` onto it is what reached Codex as `hihello`.
    const server = new FakeTmuxServer();
    server.composer = 'hi';
    const { subject, slept } = delivery(server);

    // Act
    const refused = await subject.deliver(SESSION, 'hello').catch((error: unknown) => error);

    // Assert
    should(refused).be.instanceof(ComposerOccupiedError);
    should((refused as ComposerOccupiedError).draft).equal('hi');
    should(server.calls.some(call => call[0] === 'send-keys')).be.false();
    should(slept.length).be.below(3);
  });

  it('should refuse at the fill too, when the draft appeared after the pane read ready', async () => {
    const server = new FakeTmuxServer();
    const { subject } = delivery(server);
    await subject.waitReady(SESSION);
    server.composer = 'my own words';

    await should(subject.deliver(SESSION, 'hello')).be.rejectedWith(ComposerOccupiedError);
    should(server.submitted).be.empty();
  });
});
