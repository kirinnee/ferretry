import { describe, it } from 'bun:test';
import should from 'should';
import {
  capturePaneArguments,
  hasSessionArguments,
  killSessionArguments,
  listSessionsArguments,
  newSessionArguments,
  paneMetadataArguments,
  panePidArguments,
  paneTarget,
  parsePaneMetadata,
  promptIsReady,
  retryDelays,
  sendKeyArguments,
  sendLiteralArguments,
  sessionTarget,
  TmuxAddressError,
  TmuxController,
  type TmuxCommandPort,
  type TmuxCommandResult,
  windowTarget,
} from '../../../src/lib/index.ts';

class FakeTmux implements TmuxCommandPort {
  readonly received: string[][] = [];

  constructor(private readonly results: TmuxCommandResult[]) {}

  async execute(arguments_: readonly string[]): Promise<TmuxCommandResult> {
    this.received.push([...arguments_]);
    return this.results.shift() ?? { code: 0, stdout: '', stderr: '' };
  }
}

const ok = (stdout = ''): TmuxCommandResult => ({ code: 0, stdout, stderr: '' });

describe('tmux addresses and commands', () => {
  it('should construct unambiguous validated session, window, pane, and command arguments', () => {
    // Act
    const actual = {
      session: sessionTarget('work-1'),
      window: windowTarget('work-1', 'main'),
      pane: paneTarget('work-1', 'main', 2),
      has: hasSessionArguments('work-1'),
      list: listSessionsArguments(),
      history: capturePaneArguments('work-1', true),
      visible: capturePaneArguments('work-1', false),
      metadata: paneMetadataArguments('work-1'),
      panePid: panePidArguments('work-1'),
      literal: sendLiteralArguments('work-1', 'hello world'),
      key: sendKeyArguments('work-1', 'C-u'),
      launch: newSessionArguments({
        session: 'work-1',
        cwd: '/tmp',
        command: ['agent', '--auto'],
        width: 160,
        height: 50,
      }),
      kill: killSessionArguments('work-1'),
    };

    // Assert
    should(actual).deepEqual({
      session: 'work-1',
      window: 'work-1:main',
      pane: 'work-1:main.2',
      has: ['has-session', '-t', 'work-1'],
      list: ['list-sessions', '-F', '#{session_name}'],
      history: ['capture-pane', '-p', '-S', '-', '-t', 'work-1'],
      visible: ['capture-pane', '-p', '-t', 'work-1'],
      panePid: ['display-message', '-p', '-t', 'work-1', '#{pane_pid}'],
      metadata: [
        'display-message',
        '-p',
        '-t',
        'work-1',
        '#{pane_dead}|#{pane_dead_status}|#{cursor_x}|#{cursor_y}|#{pane_height}|#{pane_width}',
      ],
      literal: ['send-keys', '-t', 'work-1', '-l', 'hello world'],
      key: ['send-keys', '-t', 'work-1', 'C-u'],
      launch: ['new-session', '-d', '-s', 'work-1', '-c', '/tmp', '-x', '160', '-y', '50', 'agent', '--auto'],
      kill: ['kill-session', '-t', 'work-1'],
    });
  });

  it('should refuse ambiguous targets and unsafe key payloads', () => {
    // Act + Assert
    for (const action of [
      () => sessionTarget('Work'),
      () => windowTarget('work', 'main:other'),
      () => paneTarget('work', 'main', -1),
      () => sendLiteralArguments('work', ''),
      () => sendKeyArguments('work', 'Enter;kill'),
    ])
      should(action).throw(TmuxAddressError);
  });
});

describe('tmux pane policy', () => {
  it('should parse tmux metadata and identify the prompt without treating work or startup dialogs as ready', () => {
    // Act
    const metadata = parsePaneMetadata('0|12|1|2|50|160\n');
    const malformed = parsePaneMetadata('1|bad||||');
    const ready = promptIsReady('transcript\n› ', 1, 0);

    // Assert
    should(metadata).deepEqual({ dead: false, exitCode: 12, cursorX: 1, cursorY: 2, height: 50, width: 160 });
    should(malformed).deepEqual({
      dead: true,
      exitCode: undefined,
      cursorX: undefined,
      cursorY: undefined,
      height: undefined,
      width: undefined,
    });
    should(ready).be.true();
    should(promptIsReady('Do you trust the contents of this directory?\n› ')).be.false();
    should(promptIsReady('Working (4s)\n› ')).be.false();
    should(promptIsReady('› 1. choice', 0, 0)).be.false();
    should(promptIsReady('tell the model what to do differently')).be.true();
    should(promptIsReady('plain output')).be.false();
  });

  it('should calculate a bounded deterministic retry schedule and reject invalid policy', () => {
    // Act + Assert
    should(retryDelays(5, 10, 40)).deepEqual([10, 20, 40, 40, 40]);
    should(retryDelays(0)).deepEqual([]);
    should(() => retryDelays(-1)).throw(RangeError);
    should(() => retryDelays(1, 20, 10)).throw(RangeError);
  });
});

describe('TmuxController', () => {
  it('should orchestrate lifecycle, capture, state, and key delivery through its injected port', async () => {
    // Arrange
    const fake = new FakeTmux([
      ok(),
      ok(' one \n\ntwo\n'),
      ok('history'),
      ok(),
      ok('0|0|0|1|50|160'),
      ok('all history'),
      ok('output\n› '),
      { code: 1, stdout: '', stderr: 'missing' },
      ok(),
      ok(),
      ok(),
      ok(),
      ok(),
      ok(),
    ]);
    const subject = new TmuxController(fake);

    // Act
    const alive = await subject.alive('work');
    const sessions = await subject.listSessions();
    const missingCapture = await subject.capture('work');
    const state = await subject.state('work');
    await subject.launch({ session: 'work', cwd: '/tmp', command: ['agent'] });
    await subject.sendLiteral('work', 'hello');
    await subject.sendKey('work', 'Enter');
    await subject.stop('work');

    // Assert
    should(alive).be.true();
    should(sessions).deepEqual(['one', 'two']);
    should(missingCapture).equal('history');
    should(state).deepEqual({
      alive: true,
      dead: false,
      exitCode: 0,
      cursorX: 0,
      cursorY: 1,
      height: 50,
      width: 160,
      promptReady: true,
      history: 'all history',
      visible: 'output\n› ',
    });
    should(fake.received).deepEqual([
      ['has-session', '-t', 'work'],
      ['list-sessions', '-F', '#{session_name}'],
      ['capture-pane', '-p', '-S', '-', '-t', 'work'],
      ['has-session', '-t', 'work'],
      [
        'display-message',
        '-p',
        '-t',
        'work',
        '#{pane_dead}|#{pane_dead_status}|#{cursor_x}|#{cursor_y}|#{pane_height}|#{pane_width}',
      ],
      ['capture-pane', '-p', '-S', '-', '-t', 'work'],
      ['capture-pane', '-p', '-t', 'work'],
      ['has-session', '-t', 'work'],
      ['new-session', '-d', '-s', 'work', '-c', '/tmp', 'agent'],
      ['set-option', '-t', 'work', 'remain-on-exit', 'on'],
      ['send-keys', '-t', 'work', '-l', 'hello'],
      ['send-keys', '-t', 'work', 'Enter'],
      ['has-session', '-t', 'work'],
      ['kill-session', '-t', 'work'],
    ]);
  });

  it('should return safe fallbacks and surface tmux failures', async () => {
    // Arrange
    const unavailable = new TmuxController(
      new FakeTmux([
        { code: 1, stdout: '', stderr: 'gone' },
        { code: 1, stdout: '', stderr: 'gone' },
      ]),
    );
    const launchFailure = new TmuxController(
      new FakeTmux([
        { code: 1, stdout: '', stderr: 'missing' },
        { code: 1, stdout: '', stderr: 'create failed' },
      ]),
    );
    const configureFailure = new TmuxController(
      new FakeTmux([
        { code: 1, stdout: '', stderr: 'missing' },
        ok(),
        { code: 1, stdout: '', stderr: 'configure failed' },
      ]),
    );
    const sendFailure = new TmuxController(new FakeTmux([{ code: 1, stdout: '', stderr: '' }]));
    const keyFailure = new TmuxController(new FakeTmux([{ code: 1, stdout: '', stderr: '' }]));
    const stopFailure = new TmuxController(new FakeTmux([ok(), { code: 1, stdout: '', stderr: '' }]));

    // Act + Assert
    should(await unavailable.listSessions()).deepEqual([]);
    should(await unavailable.state('work')).deepEqual({
      alive: false,
      dead: true,
      promptReady: false,
      history: '',
      visible: '',
    });
    await should(launchFailure.launch({ session: 'work', cwd: '/tmp', command: ['agent'] })).rejectedWith(
      'create failed',
    );
    await should(configureFailure.launch({ session: 'work', cwd: '/tmp', command: ['agent'] })).rejectedWith(
      'configure failed',
    );
    await should(sendFailure.sendLiteral('work', 'hello')).rejectedWith('tmux could not send literal text');
    await should(keyFailure.sendKey('work', 'Enter')).rejectedWith('tmux could not send key');
    await should(stopFailure.stop('work')).rejectedWith('tmux could not stop the session');
  });
});
