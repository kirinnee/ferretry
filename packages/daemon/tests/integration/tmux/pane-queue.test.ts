import { describe, it } from 'bun:test';
import should from 'should';
import { PaneQueueError, TmuxPaneQueue } from '../../../src/adapters/index.ts';
import { TmuxController, type TmuxCommandPort, type TmuxCommandResult } from '../../../src/lib/index.ts';

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
  /** Whether the composer ever accepts the text at all. */
  accepts = true;

  constructor(
    private readonly enterSubmits: boolean,
    /** Whether the pane is visibly working, which is its own proof a queued message will be read. */
    private readonly working = true,
  ) {}

  async execute(argv: readonly string[]): Promise<TmuxCommandResult> {
    this.calls.push(argv);
    const command = argv[0];
    if (command === 'has-session') return ok('');
    if (command === 'display-message') return ok(`0||${2 + this.composer.length}|1|24|80\n`);
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
    // The Claude shape: Enter hands the text to the harness, which echoes it as a queued line.
    if (key === 'Enter' && this.enterSubmits) this.queued = true;
    // The Codex shape: Tab is what moves a held composer into the explicit queue.
    if (key === 'Tab') this.queued = true;
    return ok('');
  }

  private frame(): string {
    const lines = [this.working ? '✻ Lollygagging… (34s · ⚒ 2.1k tokens)' : 'idle'];
    // Once queued, the harness shows the message as a pending line rather than as composer text.
    if (this.queued) lines.push(`❯ ${this.composer} (queued)`);
    else {
      lines.push(`> ${this.composer}`);
      // The hint only appears while the composer is genuinely holding something.
      if (this.composer !== '' && !this.enterSubmits) lines.push('  tab to queue message');
    }
    return `${lines.join('\n')}\n`;
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
    await subject.queue(SESSION, 'read the queued brief');

    // Assert
    should(pane.keysSent()).deepEqual(['Enter']);
    should(pane.queued).be.true();
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

  it('should refuse when nothing proves the message is being held', async () => {
    // The pane went idle between the fill and the submit, so Enter consumed the text at a prompt and
    // nothing is holding it and nothing is working. Reporting `queued` here is how a message is lost
    // silently: the caller waits at a turn boundary the harness passed seconds earlier.
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
    await should(subject.queue(SESSION, 'read the queued brief')).be.rejectedWith(PaneQueueError);
    await should(subject.queue(SESSION, 'read the queued brief')).be.rejectedWith(/without queue evidence/u);
  });

  it('should give up rather than keep typing into a composer that takes nothing', async () => {
    // Arrange
    const pane = new BusyPane(true);
    pane.accepts = false;
    const { subject } = queue(pane, { composerAttempts: 2, composerPolls: 1 });

    // Act / Assert
    await should(subject.queue(SESSION, 'read the queued brief')).be.rejectedWith(/did not land in the composer/u);
    // Cleared before a RETRY only — never before the first attempt, which would destroy a paste the
    // harness had already taken.
    should(pane.keysSent()).deepEqual(['C-u']);
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
