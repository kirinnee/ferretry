import { describe, it } from 'bun:test';
import should from 'should';
import { TmuxCodexPickerPane } from '../../../../src/adapters/index.ts';
import { CodexPickerCleanup, type TmuxCommandPort, type TmuxCommandResult } from '../../../../src/lib/index.ts';

const ok = (stdout = ''): TmuxCommandResult => ({ code: 0, stdout, stderr: '' });
const failed = (stderr: string): TmuxCommandResult => ({ code: 1, stdout: '', stderr });

const PICKER = ['Select Model', '  1. gpt-5-codex', ''].join('\n');
const IDLE = ['> ', ''].join('\n');

/**
 * A fake tmux process. Deliberately NOT a real tmux server: this suite drives a
 * pane through key sends, and the fleet's live server is production.
 */
class FakeTmux implements TmuxCommandPort {
  readonly received: string[][] = [];

  constructor(private readonly answer: (arguments_: readonly string[], index: number) => TmuxCommandResult) {}

  async execute(arguments_: readonly string[]): Promise<TmuxCommandResult> {
    const index = this.received.length;
    this.received.push([...arguments_]);
    return this.answer(arguments_, index);
  }
}

/** Answers the four cleanup commands, serving pane captures from a script. */
const paneServer = (
  panes: readonly string[],
  cursor = '0|1',
  paneId = '%7',
): { readonly tmux: FakeTmux; captures: () => number } => {
  let captures = 0;
  const tmux = new FakeTmux(arguments_ => {
    if (arguments_[0] === 'send-keys') return ok();
    if (arguments_.at(-1) === '#{pane_id}') return ok(`${paneId}\n`);
    if (arguments_.at(-1) === '#{cursor_x}|#{cursor_y}') return ok(`${cursor}\n`);
    const pane = panes[Math.min(captures, panes.length - 1)] ?? '';
    captures += 1;
    return ok(pane);
  });
  return { tmux, captures: () => captures };
};

describe('TmuxCodexPickerPane', () => {
  it('should resolve, capture and dismiss through pane-scoped commands only', async () => {
    // Arrange
    const { tmux } = paneServer([PICKER]);
    const subject = new TmuxCodexPickerPane(tmux);

    // Act
    const paneId = await subject.resolvePaneId('fy-abc');
    const observation = await subject.observe(paneId);
    await subject.sendEscape(paneId);

    // Assert: after the first command every argument vector targets the pane id,
    // never the session name, and no vector starts with a server option.
    should(paneId).eql('%7');
    should(observation.visiblePane).eql(PICKER);
    should(tmux.received[0]).eql(['display-message', '-p', '-t', 'fy-abc', '#{pane_id}']);
    should(tmux.received.slice(1).every(vector => vector.includes('%7'))).eql(true);
    should(tmux.received.some(vector => vector.includes('fy-abc') && vector[3] !== 'fy-abc')).eql(false);
    should(tmux.received.every(vector => vector[0]?.startsWith('-') === false)).eql(true);
  });

  it('should read an idle prompt as prompt-ready from the real cursor position', async () => {
    // Arrange: the cursor sits on the prompt line, which is what makes it idle.
    const { tmux } = paneServer([IDLE], '2|0');
    const subject = new TmuxCodexPickerPane(tmux);

    // Act
    const observation = await subject.observe('%7');

    // Assert
    should(observation.promptReady).eql(true);
  });

  it.each([
    {
      name: 'the pane cannot be resolved',
      answer: () => failed('no server running on /tmp/fy/tmux.sock'),
      act: (subject: TmuxCodexPickerPane) => subject.resolvePaneId('fy-abc'),
      message: 'no server running on /tmp/fy/tmux.sock',
    },
    {
      name: 'the capture fails',
      answer: (arguments_: readonly string[]) =>
        arguments_[0] === 'capture-pane' ? failed('pane not found') : ok('0|1\n'),
      act: (subject: TmuxCodexPickerPane) => subject.observe('%7'),
      message: 'pane not found',
    },
    {
      name: 'the cursor read fails',
      answer: (arguments_: readonly string[]) =>
        arguments_.at(-1) === '#{cursor_x}|#{cursor_y}' ? failed('unknown pane') : ok(IDLE),
      act: (subject: TmuxCodexPickerPane) => subject.observe('%7'),
      message: 'unknown pane',
    },
    {
      name: 'the cursor is unreadable',
      answer: (arguments_: readonly string[]) =>
        arguments_.at(-1) === '#{cursor_x}|#{cursor_y}' ? ok('|\n') : ok(IDLE),
      act: (subject: TmuxCodexPickerPane) => subject.observe('%7'),
      message: 'tmux reported an unreadable cursor position for pane %7:',
    },
    {
      name: 'the key send fails',
      answer: () => failed('send-keys: pane is dead'),
      act: (subject: TmuxCodexPickerPane) => subject.sendEscape('%7'),
      message: 'send-keys: pane is dead',
    },
  ])('should throw rather than look empty when $name', async ({ answer, act, message }) => {
    // Arrange
    const subject = new TmuxCodexPickerPane(new FakeTmux(answer));

    // Act / Assert: a swallowed failure would be read downstream as an idle pane.
    await should(act(subject)).be.rejectedWith(new RegExp(message.replaceAll(/[$()*+.?[\\\]^{|}]/g, String.raw`\$&`)));
  });

  it.each([
    { name: 'the pane resolution', predicate: (vector: readonly string[]) => vector.at(-1) === '#{pane_id}' },
    { name: 'the capture', predicate: (vector: readonly string[]) => vector[0] === 'capture-pane' },
    { name: 'the key send', predicate: (vector: readonly string[]) => vector[0] === 'send-keys' },
  ])('should report a silent tmux failure during $name with a message of its own', async ({ predicate }) => {
    // Arrange: tmux exiting non-zero with an empty stderr is common on a torn-down
    // pane, and an empty message tells an operator nothing.
    const tmux = new FakeTmux(arguments_ => {
      if (predicate(arguments_)) return failed('   ');
      if (arguments_.at(-1) === '#{pane_id}') return ok('%7\n');
      if (arguments_.at(-1) === '#{cursor_x}|#{cursor_y}') return ok('2|0\n');
      return ok(IDLE);
    });
    const subject = new TmuxCodexPickerPane(tmux);

    // Act / Assert
    await should(
      (async () => {
        const paneId = await subject.resolvePaneId('fy-abc');
        await subject.observe(paneId);
        await subject.sendEscape(paneId);
      })(),
    ).be.rejectedWith(/^tmux could not /);
  });

  it('should drive a real cleanup to a settled prompt through the tmux port', async () => {
    // Arrange: the picker closes on the second Escape.
    const { tmux } = paneServer([PICKER, PICKER, IDLE], '2|0');
    const cleanup = new CodexPickerCleanup(
      new TmuxCodexPickerPane(tmux),
      { sleep: async () => undefined },
      {
        settleMs: 0,
        maxAttempts: 4,
      },
    );

    // Act
    const outcome = await cleanup.dismiss('fy-abc');

    // Assert
    should(outcome).eql({ kind: 'settled' });
    should(tmux.received.filter(vector => vector[0] === 'send-keys')).eql([
      ['send-keys', '-t', '%7', 'Escape'],
      ['send-keys', '-t', '%7', 'Escape'],
    ]);
  });

  it('should surface an unresolvable pane as unconfirmed rather than escaping blindly', async () => {
    // Arrange
    const { tmux } = paneServer([IDLE], '2|0', 'fy-abc');
    const cleanup = new CodexPickerCleanup(new TmuxCodexPickerPane(tmux), { sleep: async () => undefined });

    // Act
    const outcome = await cleanup.dismiss('fy-abc');

    // Assert
    should(outcome).eql({
      kind: 'unconfirmed',
      reason: 'tmux returned "fy-abc", which is not a pane cleanup can address',
    });
    should(tmux.received.filter(vector => vector[0] === 'send-keys')).eql([]);
  });
});
