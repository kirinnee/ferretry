import { describe, it } from 'bun:test';
import should from 'should';
import {
  type CapturedFrame,
  capturedFrameIsCurrent,
  type PaneActivity,
  paneActivityArguments,
  paneActivityFormat,
  paneIdentityTableArguments,
  paneStateFrom,
  parsePaneActivity,
  parsePaneIdentityTable,
  resolveSessionTarget,
  type TmuxCommandPort,
  type TmuxCommandResult,
  TmuxController,
} from '../../../src/lib/index.ts';

class FakeTmux implements TmuxCommandPort {
  readonly received: string[][] = [];

  constructor(private readonly results: TmuxCommandResult[]) {}

  async execute(arguments_: readonly string[]): Promise<TmuxCommandResult> {
    this.received.push([...arguments_]);
    return this.results.shift() ?? { code: 0, stdout: '', stderr: '' };
  }
}

const ok = (stdout: string): TmuxCommandResult => ({ code: 0, stdout, stderr: '' });
const failed = (stderr: string): TmuxCommandResult => ({ code: 1, stdout: '', stderr });

const ACTIVITY: PaneActivity = {
  dead: false,
  cursorX: 2,
  cursorY: 5,
  height: 40,
  width: 120,
  activityAt: 1_792_626_405,
  historySize: 310,
  paneId: '%4',
  pid: 4_242,
};

describe('a pane’s activity, in one question', () => {
  it('should ask for the metadata, the activity stamp, the scrollback size and the identity at once', () => {
    // Act + Assert
    should(paneActivityFormat).equal(
      '#{pane_dead}|#{pane_dead_status}|#{cursor_x}|#{cursor_y}|#{pane_height}|#{pane_width}|#{window_activity}|#{history_size}|#{pane_id}|#{pane_pid}',
    );
    should(paneActivityArguments('fy-work')).deepEqual(['display-message', '-p', '-t', 'fy-work', paneActivityFormat]);
    should(paneIdentityTableArguments()).deepEqual([
      'list-panes',
      '-a',
      '-F',
      '#{session_name}\t#{window_active}#{pane_active}\t#{pane_id}\t#{pane_pid}',
    ]);
  });

  it.each([
    ['0||2|5|40|120|1792626405|310|%4|4242\n', { ...ACTIVITY, exitCode: undefined }],
    [
      '1|3|0|0|40|120|1792626400|0|%4|4242',
      { ...ACTIVITY, dead: true, exitCode: 3, cursorX: 0, cursorY: 0, activityAt: 1_792_626_400, historySize: 0 },
    ],
    [
      '0||||||',
      { dead: false, exitCode: undefined, cursorX: undefined, cursorY: undefined, height: undefined, width: undefined },
    ],
    ['0||1|1|10|10|soon|-1|%x|1', { dead: false, exitCode: undefined, cursorX: 1, cursorY: 1, height: 10, width: 10 }],
  ])('should parse %j', (input, expected) => {
    // Act
    const actual = parsePaneActivity(input);

    // Assert
    should(actual).deepEqual(expected);
  });

  it('should build a live pane’s state from its metadata and frames', () => {
    // Act
    const ready = paneStateFrom({ dead: false, cursorX: 2, cursorY: 0 }, '❯ ');
    const dead = paneStateFrom({ dead: true, exitCode: 1, cursorX: 2, cursorY: 0 }, '❯ ', 'scrollback');

    // Assert
    should(ready).deepEqual({
      alive: true,
      dead: false,
      cursorX: 2,
      cursorY: 0,
      promptReady: true,
      history: '',
      visible: '❯ ',
    });
    should(dead).match({ alive: true, dead: true, promptReady: false, history: 'scrollback' });
  });
});

describe('whether a captured frame is still the frame on screen', () => {
  const frame: CapturedFrame = { activity: ACTIVITY, visible: 'screen', capturedAtSecond: 1_792_626_406 };

  it('should hold a frame captured in a second after the pane last drew, while nothing has moved', () => {
    // Act + Assert
    should(capturedFrameIsCurrent(frame, { ...ACTIVITY })).be.true();
  });

  it.each([
    ['no frame', undefined, ACTIVITY],
    ['a capture in the very second of the last output', { ...frame, capturedAtSecond: 1_792_626_405 }, ACTIVITY],
    ['an unknown activity stamp', frame, { ...ACTIVITY, activityAt: undefined }],
    ['an unknown scrollback size', frame, { ...ACTIVITY, historySize: undefined }],
    ['new output', frame, { ...ACTIVITY, activityAt: 1_792_626_407 }],
    ['grown scrollback', frame, { ...ACTIVITY, historySize: 311 }],
    ['a death', frame, { ...ACTIVITY, dead: true }],
    ['a moved cursor column', frame, { ...ACTIVITY, cursorX: 3 }],
    ['a moved cursor row', frame, { ...ACTIVITY, cursorY: 6 }],
    ['a resize in height', frame, { ...ACTIVITY, height: 41 }],
    ['a resize in width', frame, { ...ACTIVITY, width: 121 }],
    ['another pane', frame, { ...ACTIVITY, paneId: '%5' }],
  ])('should capture again after %s', (_label, held, activity) => {
    // Act + Assert
    should(capturedFrameIsCurrent(held as CapturedFrame | undefined, activity as PaneActivity)).be.false();
  });
});

describe('resolving a session target as tmux does', () => {
  it.each([
    ['an exact name, even past a longer one', 'fy-a', ['fy-ab', 'fy-a'], 'fy-a'],
    ['the one name it prefixes', 'fy-a', ['fy-b', 'fy-abc'], 'fy-abc'],
    ['nothing for an ambiguous prefix', 'fy-a', ['fy-ab', 'fy-ac'], undefined],
    ['nothing for no match', 'fy-z', ['fy-ab'], undefined],
  ])('should resolve %s', (_label, target, names, expected) => {
    // Act + Assert
    should(resolveSessionTarget(target as string, names as string[])).equal(expected);
  });

  it('should key each session’s active pane by its name, and only its active pane', () => {
    // Arrange
    const input = [
      'fy-a\t11\t%1\t100',
      'fy-a\t10\t%2\t101',
      'fy-b\t01\t%3\t102',
      'fy-b\t11\t%4\t103',
      'fy-c\t11\t%bad\t104',
      '\t11\t%5\t105',
      '',
    ].join('\n');

    // Act
    const actual = parsePaneIdentityTable(input);

    // Assert
    should([...actual]).deepEqual([
      ['fy-a', { paneId: '%1', pid: 100 }],
      ['fy-b', { paneId: '%4', pid: 103 }],
    ]);
  });
});

describe('TmuxController, asking less', () => {
  it('should skip the scrollback for a reader that only wants the screen', async () => {
    // Arrange
    const tmux = new FakeTmux([ok(''), ok('0||2|0|24|80'), ok('❯ \n')]);
    const subject = new TmuxController(tmux);

    // Act
    const actual = await subject.state('fy-work', { history: false });

    // Assert
    should(actual).match({ alive: true, dead: false, history: '', visible: '❯ \n' });
    should(tmux.received.map(command => command[0])).deepEqual(['has-session', 'display-message', 'capture-pane']);
    should(tmux.received[2]).deepEqual(['capture-pane', '-p', '-t', 'fy-work']);
  });

  it('should answer activity and the visible frame, or nothing when tmux refuses', async () => {
    // Arrange
    const tmux = new FakeTmux([
      ok('0||2|5|40|120|1792626405|310|%4|4242\n'),
      failed("can't find session: fy-work\n"),
      ok('frame\n'),
      failed("can't find pane\n"),
    ]);
    const subject = new TmuxController(tmux);

    // Act
    const activity = await subject.activity('fy-work');
    const absent = await subject.activity('fy-work');
    const visible = await subject.visible('fy-work');
    const unreadable = await subject.visible('fy-work');

    // Assert
    should(activity).deepEqual({ ...ACTIVITY, exitCode: undefined });
    should(absent).be.undefined();
    should(visible).equal('frame\n');
    should(unreadable).be.undefined();
  });

  it('should list every session’s pane at once, read no server as no panes, and refuse anything else', async () => {
    // Arrange
    const tmux = new FakeTmux([
      ok('fy-a\t11\t%1\t100\n'),
      failed('no server running on /tmp/fy/tmux.sock\n'),
      failed('lost server\n'),
    ]);
    const subject = new TmuxController(tmux);

    // Act
    const listed = await subject.paneIdentities();
    const empty = await subject.paneIdentities();
    const refused = await subject.paneIdentities();

    // Assert
    should([...(listed ?? [])]).deepEqual([['fy-a', { paneId: '%1', pid: 100 }]]);
    should(empty?.size).equal(0);
    should(refused).be.undefined();
  });
});
