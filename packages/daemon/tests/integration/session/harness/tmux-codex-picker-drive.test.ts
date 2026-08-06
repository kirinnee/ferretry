import { describe, it } from 'bun:test';
import should from 'should';
import { TmuxCodexPickerDrive } from '../../../../src/adapters/index.ts';
import { TmuxPaneDelivery } from '../../../../src/adapters/tmux/index.ts';
import {
  CodexModelPickerDriver,
  CodexPickerDriveError,
  type TmuxCommandPort,
  type TmuxCommandResult,
  TmuxController,
} from '../../../../src/lib/index.ts';
import { FakeTmuxServer } from '../../support/fake-tmux-server.ts';

/**
 * Driving a Codex picker over tmux argument vectors.
 *
 * A fake tmux process, deliberately: this suite SENDS KEYS, and the fleet's live server is
 * production. What it proves is the part a fake cannot fake away — which argument vectors are built,
 * that every one of them after the first addresses a pane id rather than a session name, and that a
 * pane whose screen has moved is never keyed at all.
 */

const ok = (stdout = ''): TmuxCommandResult => ({ code: 0, stdout, stderr: '' });
const failed = (stderr: string): TmuxCommandResult => ({ code: 1, stdout: '', stderr });

const QUICK = ['Select Model', '  1. gpt-5.6-codex', '  2. All models', ''].join('\n');
const LEVELS = ['Select Reasoning Level for gpt-5.6-codex', '  1. Low', '  2. High', ''].join('\n');
const IDLE = ['› ', ''].join('\n');
const PANE_ID = '%7';

interface FakeOptions {
  /** Visible pane text, one entry per capture, repeating the last. */
  readonly panes: readonly string[];
  readonly cursor?: string;
  readonly paneId?: string;
  /** Fails the nth `send-keys` that carries a bare digit. */
  readonly failDigit?: boolean;
  readonly resolveFails?: boolean;
  readonly captureFails?: boolean;
}

class FakeTmux implements TmuxCommandPort {
  readonly received: string[][] = [];
  #captures = 0;

  constructor(private readonly options: FakeOptions) {}

  async execute(argv: readonly string[]): Promise<TmuxCommandResult> {
    this.received.push([...argv]);
    if (argv[0] === 'has-session') return ok();
    if (argv[0] === 'send-keys') {
      const digit = argv.at(-1) ?? '';
      if (this.options.failDigit === true && /^[1-9]$/.test(digit)) return failed('tmux could not send it');
      return ok();
    }
    if (argv.at(-1) === '#{pane_id}')
      return this.options.resolveFails === true ? failed('no such pane') : ok(`${this.options.paneId ?? PANE_ID}\n`);
    if (argv.at(-1)?.includes('#{cursor_x}') === true) return ok(`${this.options.cursor ?? '0|1'}\n`);
    if (argv[0] === 'display-message') return ok(`0|0|${this.options.cursor ?? '0|1'}||\n`);
    if (argv[0] === 'capture-pane') {
      if (this.options.captureFails === true) return failed('tmux could not capture');
      const pane = this.options.panes[Math.min(this.#captures, this.options.panes.length - 1)] ?? '';
      this.#captures += 1;
      return ok(pane);
    }
    return ok();
  }
}

const noSleep = async () => undefined;

function subjectOver(options: FakeOptions, openCommand = '/model') {
  const tmux = new FakeTmux(options);
  const controller = new TmuxController(tmux);
  const delivery = new TmuxPaneDelivery(controller, noSleep, { pollMs: 0, dialogSettleMs: 0 });
  return { tmux, subject: new TmuxCodexPickerDrive(tmux, controller, delivery, 'fy-abc', openCommand) };
}

/** The expectation a driver would hand the transport for the first quick row. */
const quickRow = { kind: 'quick-models' as const, title: 'Select Model', row: { number: 1, name: 'gpt-5.6-codex' } };

describe('TmuxCodexPickerDrive', () => {
  it('should read the pane as a frame the driver can classify', async () => {
    // Arrange
    const { subject } = subjectOver({ panes: [QUICK] });

    // Act
    const frame = await subject.readPane();

    // Assert
    should(frame.alive).equal(true);
    should(frame.dead).equal(false);
    should(frame.visible).equal(QUICK);
  });

  it('should send a verified digit to the exact pane it just re-read', async () => {
    // A session name re-resolves to whichever pane is active when the command runs; the pane id does
    // not. That is the whole reason this adapter resolves one first.
    // Arrange
    const { tmux, subject } = subjectOver({ panes: [QUICK] });

    // Act
    await subject.sendKey('1', quickRow);

    // Assert
    const sent = tmux.received.filter(argv => argv[0] === 'send-keys');
    should(sent).deepEqual([['send-keys', '-t', PANE_ID, '1']]);
    should(tmux.received.every(argv => argv[0] !== '-S' && argv[0] !== '-L')).equal(true);
  });

  it('should refuse a key that is not a single digit', async () => {
    // Arrange
    const { tmux, subject } = subjectOver({ panes: [QUICK] });

    // Act
    const failure = await subject
      .sendKey('Enter', { ...quickRow, row: { number: 1, name: 'gpt-5.6-codex' } })
      .catch(error => error);

    // Assert
    should(failure).be.instanceOf(CodexPickerDriveError);
    should(failure).match({ message: /refusing to send Enter into a Codex picker/u });
    should(tmux.received).deepEqual([]);
  });

  it('should refuse a digit that does not match the row it names', async () => {
    // The digit and the verified row are two statements of the same fact; a disagreement means one of
    // them is stale, and sending either would be a guess.
    // Arrange
    const { tmux, subject } = subjectOver({ panes: [QUICK] });

    // Act
    const failure = await subject.sendKey('2', quickRow).catch(error => error);

    // Assert
    should(failure).match({ message: /no longer matches the verified row/u });
    should(tmux.received).deepEqual([]);
  });

  it('should not send a key when the pane no longer shows the verified row', async () => {
    // Arrange
    const { tmux, subject } = subjectOver({ panes: [LEVELS] });

    // Act
    const failure = await subject.sendKey('1', quickRow).catch(error => error);

    // Assert
    should(failure).match({ message: /changed before the verified shortcut could be sent/u });
    should(tmux.received.filter(argv => argv[0] === 'send-keys')).deepEqual([]);
  });

  it('should refuse when tmux cannot name a pane to address', async () => {
    // Arrange
    const { tmux, subject } = subjectOver({ panes: [QUICK], resolveFails: true });

    // Act
    const failure = await subject.sendKey('1', quickRow).catch(error => error);

    // Assert
    should(failure).match({ message: 'no such pane' });
    should(tmux.received.filter(argv => argv[0] === 'send-keys')).deepEqual([]);
  });

  it('should refuse a pane id that is not an address', async () => {
    // Arrange
    const { subject } = subjectOver({ panes: [QUICK], paneId: 'the active one' });

    // Act
    const failure = await subject.sendKey('1', quickRow).catch(error => error);

    // Assert
    should(failure).match({ message: /pane could not be resolved/u });
  });

  it('should refuse when the pane could not be captured for re-checking', async () => {
    // A capture that did not run is no more proof the row is still there than a row that moved.
    // Arrange
    const { subject } = subjectOver({ panes: [QUICK], captureFails: true });

    // Act
    const failure = await subject.sendKey('1', quickRow).catch(error => error);

    // Assert
    should(failure).match({ message: 'tmux could not capture' });
  });

  it('should surface a send that tmux itself rejected', async () => {
    // Arrange
    const { subject } = subjectOver({ panes: [QUICK], failDigit: true });

    // Act
    const failure = await subject.sendKey('1', quickRow).catch(error => error);

    // Assert
    should(failure).match({ message: 'tmux could not send it' });
  });

  it('should open the picker through the ordinary delivery path', async () => {
    // Not by typing keys at a pane: that path already proves the payload reached the composer and
    // left it, and already classifies what happened next. A second opinion here would let the daemon
    // disagree with itself about whether it had just started a paid turn.
    // Arrange — a pane that consumes a slash command locally, which is what an opened picker is.
    const server = new FakeTmuxServer();
    server.localCommand = true;
    const controller = new TmuxController(server);
    const subject = new TmuxCodexPickerDrive(
      server,
      controller,
      new TmuxPaneDelivery(controller, noSleep, { pollMs: 0, dialogSettleMs: 0 }),
      'fy-abc',
      '/model',
    );

    // Act
    const outcome = await subject.openPicker();

    // Assert
    should(outcome).equal('handled-local');
    should(server.submitted).deepEqual(['/model']);
  });

  it('should report a picker command the harness read as a turn', async () => {
    // `turn-started` is what the driver refuses on: a `/model` that became a message is not an open
    // picker, and driving on would send digits into a conversation.
    // Arrange
    const server = new FakeTmuxServer();
    const controller = new TmuxController(server);
    const subject = new TmuxCodexPickerDrive(
      server,
      controller,
      new TmuxPaneDelivery(controller, noSleep, { pollMs: 0, dialogSettleMs: 0 }),
      'fy-abc',
      '/model',
    );

    // Act
    const outcome = await subject.openPicker();

    // Assert
    should(outcome).equal('turn-started');
  });

  it('should drive a whole switch when wired to the real decision layer', async () => {
    // The adapter and the driver together, over one fake pane: this is the only place the argument
    // vectors and the keystroke sequence are proved to agree.
    // Arrange
    const { tmux, subject } = subjectOver({ panes: [QUICK, QUICK, LEVELS, LEVELS, IDLE, IDLE] });
    const driver = new CodexModelPickerDriver(subject, { sleep: noSleep }, { settleMs: 0, maxObservations: 12 });

    // Act
    await driver.drive(
      { model: 'gpt-5.6-codex', effort: 'high' },
      { kind: 'quick-models', title: 'Select Model', rows: [{ number: 1, name: 'gpt-5.6-codex' }] },
    );

    // Assert
    const digits = tmux.received.filter(argv => argv[0] === 'send-keys' && /^[1-9]$/.test(argv.at(-1) ?? ''));
    should(digits).deepEqual([
      ['send-keys', '-t', PANE_ID, '1'],
      ['send-keys', '-t', PANE_ID, '2'],
    ]);
  });
});
