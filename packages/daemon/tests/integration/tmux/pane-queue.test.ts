import { describe, it } from 'bun:test';
import should from 'should';
import {
  COMPOSER_READS,
  ComposerOccupiedError,
  ComposerUnconfirmedError,
  ComposerUnreadableError,
  TmuxPaneQueue,
} from '../../../src/adapters/index.ts';
import { type TmuxCommandPort, type TmuxCommandResult, TmuxController } from '../../../src/lib/index.ts';

const SESSION = 'fy-session-1';

/**
 * A BUSY pane, modelled the way the two harnesses actually behave mid-turn.
 *
 * The shared `FakeTmuxServer` models an idle pane whose Enter submits, which is the opposite of what
 * this path faces: here the pane is already working, and the whole question is whether the message is
 * being HELD. `enterSubmits: false` is the Codex shape — Enter leaves the text in the composer and
 * renders a queue hint until Tab moves it into the explicit queue.
 */
class BusyPane implements TmuxCommandPort {
  readonly calls: Array<readonly string[]> = [];
  composer = '';
  /** True once the message is in the queue and no longer needs a key. */
  queued = false;
  /** What the harness is holding in its own queue, drawn as a pending block above the composer. */
  pending = '';
  /** Whether the composer ever accepts the text at all. */
  accepts = true;
  /** Seconds on the spinner, which a LIVE busy pane redraws as it ticks. */
  spinnerSeconds = 34;

  constructor(
    private readonly enterSubmits: boolean,
    /** Whether the pane is visibly working, which is its own proof a queued message will be read. */
    private readonly working = true,
  ) {}

  async execute(argv: readonly string[]): Promise<TmuxCommandResult> {
    this.calls.push(argv);
    const command = argv[0];
    if (command === 'has-session') return ok('');
    if (command === 'display-message')
      return ok(`0||${2 + this.composer.length}|${this.lines().findIndex(line => /^[>❯] /u.test(line))}|24|80\n`);
    if (command === 'capture-pane') return ok(this.frame());
    if (command === 'send-keys') return this.keys(argv);
    return ok('');
  }

  keysSent(): string[] {
    return this.calls.filter(call => call[0] === 'send-keys' && !call.includes('-l')).map(call => String(call.at(-1)));
  }

  private keys(argv: readonly string[]): TmuxCommandResult {
    const literal = argv.indexOf('-l');
    if (literal >= 0) {
      if (this.accepts) this.composer += String(argv[literal + 1]);
      return ok('');
    }
    const key = String(argv.at(-1));
    if (key === 'C-u') this.composer = '';
    // Enter mid-turn hands the text to the harness's own queue; on the Tab shape only Tab does.
    if ((key === 'Enter' && this.enterSubmits) || key === 'Tab') this.hold();
    return ok('');
  }

  /** The text leaves the composer for the pending block, as Codex 0.145–0.163 were measured to draw it. */
  private hold(): void {
    if (this.composer === '') return;
    this.queued = true;
    this.pending = this.composer;
    this.composer = '';
  }

  lines(): readonly string[] {
    const lines = [this.working ? `✻ Lollygagging… (${this.spinnerSeconds}s · ⚒ 2.1k tokens)` : 'idle'];
    if (this.pending !== '') lines.push('', '• Queued follow-up inputs', `  ↳ ${this.pending}`, '');
    lines.push(`> ${this.composer}`);
    // The hint only appears while the composer is genuinely holding something.
    // Codex draws it one blank row below the composer, as every measured version does.
    if (this.composer !== '' && !this.enterSubmits) lines.push('', '  tab to queue message');
    return lines;
  }

  private frame(): string {
    return `${this.lines().join('\n')}\n`;
  }
}

function ok(stdout: string, code = 0): TmuxCommandResult {
  return { stdout, stderr: '', code };
}

/** No real waiting: the loops are bounded by attempts, not by a clock. */
function queue(pane: BusyPane, options = {}) {
  const slept: number[] = [];
  const subject = new TmuxPaneQueue(
    new TmuxController(pane),
    async milliseconds => {
      slept.push(milliseconds);
    },
    options,
  );
  return { subject, slept };
}

describe('tmux pane queue', () => {
  it('should fill the composer, submit, and accept the pane holding the message', async () => {
    // The Claude shape: Enter is enough, and the harness echoes the queued line.
    // Arrange
    const pane = new BusyPane(true);
    const { subject } = queue(pane);

    // Act
    const outcome = await subject.queue(SESSION, 'read the queued brief');

    // Assert
    should(outcome).equal('held');
    should(pane.keysSent()).deepEqual(['Enter']);
    should(pane.queued).be.true();
  });

  it('should report a message that left the composer of a working pane as left, never as held', async () => {
    // Enter took the text and the composer is empty, but no queue shows it: Codex 0.163 steers a
    // mid-turn Enter straight into the running turn. That proves the keys were taken, not that the
    // harness is holding it, so nothing calls it queued.
    // Arrange
    const pane = new (class extends BusyPane {
      override async execute(argv: readonly string[]): Promise<TmuxCommandResult> {
        const answer = await super.execute(argv);
        if (argv[0] === 'send-keys' && argv.at(-1) === 'Enter') this.composer = '';
        return answer;
      }
    })(false, true);
    const { subject } = queue(pane);

    // Act / Assert
    should(await subject.queue(SESSION, 'read the queued brief')).equal('left');
  });

  it('should press the queue key only when the pane asks for it', async () => {
    // The Codex shape: Enter does NOT submit mid-turn, so a caller that stopped there would report a
    // message as queued while it sat unsent in the composer.
    // Arrange
    const pane = new BusyPane(false);
    const { subject } = queue(pane);

    // Act
    await subject.queue(SESSION, 'read the queued brief');

    // Assert
    should(pane.keysSent()).deepEqual(['Enter', 'Tab']);
    should(pane.queued).be.true();
  });

  it('should never call a message queued when the pane went idle and Enter simply submitted it', async () => {
    // The pane went idle between the fill and the submit, so Enter submitted the text at a prompt.
    // Reporting `queued` would have the caller wait at a turn boundary the harness already passed, and
    // failing the send would report a submitted message as lost — the transcript decides instead.
    // Arrange
    const pane = new (class extends BusyPane {
      override async execute(argv: readonly string[]): Promise<TmuxCommandResult> {
        const answer = await super.execute(argv);
        if (argv[0] === 'send-keys' && argv.at(-1) === 'Enter') this.composer = '';
        return answer;
      }
    })(false, false);
    const { subject } = queue(pane);

    // Act / Assert
    should(await subject.queue(SESSION, 'read the queued brief')).equal('left');
  });

  it('should report a message the queue key could not move as typed, which no turn end will send', async () => {
    // Arrange — the Tab shape, with a Tab that does not take (measured on 0.156.1 when it arrives
    // inside the paste-burst window): the text is still in the composer after both keys.
    const pane = new (class extends BusyPane {
      override async execute(argv: readonly string[]): Promise<TmuxCommandResult> {
        if (argv[0] !== 'send-keys' || argv.at(-1) !== 'Tab') return await super.execute(argv);
        this.calls.push(argv);
        return ok('');
      }
    })(false);
    const { subject } = queue(pane);

    // Act / Assert
    should(await subject.queue(SESSION, 'read the queued brief')).equal('typed');
    should(pane.keysSent()).deepEqual(['Enter', 'Tab']);
  });

  it('should type nothing into a composer that already holds a draft', async () => {
    // Arrange — the shape that reached Codex as `hihello`: a draft nobody submitted.
    const pane = new BusyPane(true);
    pane.composer = 'hi';
    const { subject } = queue(pane);

    // Act / Assert
    await should(subject.queue(SESSION, 'hello')).be.rejectedWith(ComposerOccupiedError);
    should(pane.calls.some(call => call[0] === 'send-keys')).be.false();
  });

  it('should type nothing into a composer it cannot place, however long it looks', async () => {
    // Arrange — text in the composer and no cursor from tmux: a draft or a placeholder, no frame says.
    const pane = new (class extends BusyPane {
      override async execute(argv: readonly string[]): Promise<TmuxCommandResult> {
        if (argv[0] === 'display-message') {
          this.calls.push(argv);
          return ok('0||||24|80\n');
        }
        return await super.execute(argv);
      }
    })(true);
    pane.composer = 'half a question';
    const { subject, slept } = queue(pane);

    // Act / Assert
    await should(subject.queue(SESSION, 'read the queued brief')).be.rejectedWith(ComposerUnreadableError);
    should(pane.calls.some(call => call[0] === 'send-keys')).be.false();
    should(slept).have.length(COMPOSER_READS - 1, 'looked again a poll apart before refusing');
    should(pane.composer).equal('half a question');
  });

  it('should type once a repaint caught halfway has passed and the composer reads empty', async () => {
    // Arrange — the first frame is mid-repaint: text on the composer row and the cursor elsewhere.
    let repainting = true;
    const pane = new (class extends BusyPane {
      override async execute(argv: readonly string[]): Promise<TmuxCommandResult> {
        if (repainting && (argv[0] === 'display-message' || argv[0] === 'capture-pane')) {
          this.calls.push(argv);
          if (argv[0] === 'capture-pane' && !argv.includes('-S')) repainting = false;
          return ok(
            argv[0] === 'capture-pane' ? '✻ Lollygagging… (34s · ⚒ 2.1k tokens)\n> Lollyga\n' : '0||0|23|24|80\n',
          );
        }
        return await super.execute(argv);
      }
    })(true);
    const { subject } = queue(pane);

    // Act
    const outcome = await subject.queue(SESSION, 'read the queued brief');

    // Assert
    should(outcome).equal('held');
    should(pane.calls.filter(call => call.includes('-l'))).have.length(1);
  });

  it('should never type twice into a busy pane that drew nothing since the keys', async () => {
    // Arrange — a frozen pane: the spinner stopped, and the composer reads empty because nothing was read.
    const pane = new BusyPane(true);
    pane.accepts = false;
    const { subject } = queue(pane);

    // Act / Assert
    await should(subject.queue(SESSION, 'read the queued brief')).be.rejectedWith(ComposerUnconfirmedError);
    should(pane.keysSent()).deepEqual([], 'no Enter on a guess, and nothing erased to make room');
    should(pane.calls.filter(call => call.includes('-l'))).have.length(1);
  });

  it('should give up after a second fill when a live busy pane drops both', async () => {
    // Arrange — the spinner keeps ticking, so the pane is reading input, and the composer stays empty.
    const pane = new (class extends BusyPane {
      override async execute(argv: readonly string[]): Promise<TmuxCommandResult> {
        if (argv[0] === 'capture-pane') this.spinnerSeconds += 1;
        return await super.execute(argv);
      }
    })(true);
    pane.accepts = false;
    const { subject } = queue(pane);

    // Act
    const refused = await subject.queue(SESSION, 'read the queued brief').catch((error: unknown) => error);

    // Assert — typed again only into a composer proven empty, and nothing is ever erased to make room:
    // Claude's `C-u` takes one wrapped row, so a clear-and-retype left a clipped copy and appended another.
    should(refused).be.instanceof(ComposerUnconfirmedError);
    should((refused as ComposerUnconfirmedError).typings).equal(2);
    should(pane.keysSent()).deepEqual([]);
    should(pane.calls.filter(call => call.includes('-l'))).have.length(2);
  });

  it('should report a submit tmux itself refused', async () => {
    // Arrange
    const pane = new BusyPane(true);
    const refusing = new (class extends BusyPane {
      override async execute(argv: readonly string[]): Promise<TmuxCommandResult> {
        const answer = await super.execute(argv);
        return argv[0] === 'send-keys' && argv.at(-1) === 'Enter' ? { code: 1, stdout: '', stderr: 'no pane' } : answer;
      }
    })(true);
    const { subject } = queue(refusing);
    void pane;

    // Act / Assert
    await should(subject.queue(SESSION, 'read the queued brief')).be.rejectedWith(/could not submit into the queue/u);
  });

  it('should submit a collapsed paste it can only recognise by its placeholder', async () => {
    // A multi-line payload renders none of its characters, so a caller that demanded a character echo
    // would clear and retype a message the harness had already taken.
    // Arrange
    const pane = new (class extends BusyPane {
      override async execute(argv: readonly string[]): Promise<TmuxCommandResult> {
        if (argv[0] === 'load-buffer') return ok('');
        if (argv[0] === 'paste-buffer') {
          this.composer = '[Pasted text #1 +3 lines]';
          return ok('');
        }
        return await super.execute(argv);
      }
    })(true);
    const { subject } = queue(pane);

    // Act
    await subject.queue(SESSION, 'line one\nline two\nline three');

    // Assert
    should(pane.queued).be.true();
  });
});
