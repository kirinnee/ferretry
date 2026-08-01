import { describe, it } from 'bun:test';
import should from 'should';
import {
  capturePaneArguments,
  deleteBufferArguments,
  hasSessionArguments,
  killPaneArguments,
  killSessionArguments,
  listSessionsArguments,
  loadBufferArguments,
  newSessionArguments,
  pasteBufferName,
  paneIdentityArguments,
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

  it('should place the session environment before the command, sorted, with the value passed through verbatim', () => {
    // Act
    const actual = newSessionArguments({
      session: 'work-1',
      cwd: '/tmp',
      command: ['agent', '--auto'],
      env: { FY_SESSION_ID: 'sess-1', FY_SESSION_BOARD_CAPABILITY: 'tok en$(whoami)`x`' },
    });

    // Assert
    // `-e` is an option of `new-session`, so anything after the command word would be an argument to
    // the AGENT rather than an environment entry — and the secret is handed over unquoted because it
    // never reaches a shell to expand it.
    should(actual).deepEqual([
      'new-session',
      '-d',
      '-s',
      'work-1',
      '-c',
      '/tmp',
      '-e',
      'FY_SESSION_BOARD_CAPABILITY=tok en$(whoami)`x`',
      '-e',
      'FY_SESSION_ID=sess-1',
      'agent',
      '--auto',
    ]);
  });

  it('should refuse an environment entry tmux would deliver under the wrong name or truncate', () => {
    // Act + Assert
    const refused: ReadonlyArray<Readonly<Record<string, string>>> = [
      { 'FY_A=B': 'value' },
      { '2FY': 'value' },
      { 'FY-A': 'value' },
      { '': 'value' },
      { FY_A: 'line\nmore' },
      { FY_A: 'nul\0byte' },
    ];
    for (const env of refused)
      should(() => newSessionArguments({ session: 'work-1', cwd: '/tmp', command: ['agent'], env })).throw(
        TmuxAddressError,
      );
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

describe('tmux bracketed paste', () => {
  it('should load the payload over stdin and paste it as one bracketed event', async () => {
    // Arrange
    const port = new FakeTmux([]);
    const stdins: (string | undefined)[] = [];
    const recording: TmuxCommandPort = {
      execute: async (arguments_, stdin) => {
        stdins.push(stdin);
        return await port.execute(arguments_);
      },
    };

    // Act
    await new TmuxController(recording).paste('work-1', 'first line\nsecond line');

    // Assert — the payload never appears in an argument vector, only on stdin.
    should(port.received).deepEqual([
      ['load-buffer', '-b', 'fy-paste-work-1', '-'],
      ['paste-buffer', '-p', '-d', '-b', 'fy-paste-work-1', '-t', 'work-1'],
    ]);
    should(stdins).deepEqual(['first line\nsecond line', undefined]);
    should(pasteBufferName('work-1')).equal('fy-paste-work-1');
    should(loadBufferArguments('work-1')).deepEqual(['load-buffer', '-b', 'fy-paste-work-1', '-']);
    should(deleteBufferArguments('work-1')).deepEqual(['delete-buffer', '-b', 'fy-paste-work-1']);
  });

  it('should refuse an empty payload and drop the buffer when the paste itself fails', async () => {
    // Arrange
    const empty = new TmuxController(new FakeTmux([]));
    const failing = new FakeTmux([ok(), { code: 1, stdout: '', stderr: 'no client' }]);
    const noMessage = new FakeTmux([ok(), { code: 1, stdout: '', stderr: '' }]);
    const loadFailure = new FakeTmux([{ code: 1, stdout: '', stderr: 'buffer too large' }]);

    // Act + Assert
    await should(empty.paste('work-1', '')).rejectedWith('paste text must not be empty');
    await should(new TmuxController(failing).paste('work-1', 'a\nb')).rejectedWith('no client');
    should(failing.received.at(-1)).deepEqual(['delete-buffer', '-b', 'fy-paste-work-1']);
    await should(new TmuxController(noMessage).paste('work-1', 'a\nb')).rejectedWith(
      'tmux could not paste into the pane',
    );
    await should(new TmuxController(loadFailure).paste('work-1', 'a\nb')).rejectedWith('buffer too large');
    should(loadFailure.received.map(call => call[0])).deepEqual(['load-buffer']);
    await should(
      new TmuxController(new FakeTmux([{ code: 1, stdout: '', stderr: '' }])).paste('work-1', 'a\nb'),
    ).rejectedWith('tmux could not load the paste buffer');
  });

  it('should read a pane identity only when tmux answers with a usable id and a real pid', async () => {
    // The reap sweep kills by pane id, so an identity it cannot fully trust must be no identity at
    // all rather than a partly-filled record. A pid of 1 is refused with the rest: init is never a
    // pane's process, and treating it as one would aim a kill at the process tree of the whole box.
    // Arrange
    const answers: Array<[string, unknown]> = [
      ['%12\t4821', { paneId: '%12', pid: 4821 }],
      ['%12\t', undefined],
      ['\t4821', undefined],
      ['0.0\t4821', undefined],
      ['%0\t4821', undefined],
      ['%12\tnot-a-pid', undefined],
      ['%12\t1', undefined],
      ['%12\t0', undefined],
      ['', undefined],
    ];

    // Act / Assert
    for (const [stdout, expected] of answers) {
      const tmux = new FakeTmux([ok(stdout)]);
      should(await new TmuxController(tmux).paneIdentity('work-1')).deepEqual(expected);
      should(tmux.received[0]).deepEqual(paneIdentityArguments('work-1'));
    }
    // tmux itself failing is also no identity, not a throw: the sweep treats absent evidence as a
    // reason to do nothing.
    should(
      await new TmuxController(new FakeTmux([{ code: 1, stdout: '%12\t4821', stderr: 'no server' }])).paneIdentity(
        'work-1',
      ),
    ).equal(undefined);
  });

  it('should refuse to build a kill for anything that is not a real pane id', () => {
    // This validation is the last thing standing between the sweep and an arbitrary kill target, so
    // it rejects rather than coerces. `%0` is excluded deliberately: tmux numbers panes from 1, and
    // a zero would most likely be a parsed-empty value rather than a pane.
    // Act / Assert
    should(killPaneArguments('%12')).deepEqual(['kill-pane', '-t', '%12']);
    for (const bad of ['%0', '0.0', '12', '%', '', '%1x', '%-1', 'work-1', '%12 ; rm -rf /', '%１２']) {
      should(() => killPaneArguments(bad)).throw(TmuxAddressError);
    }
  });

  it('should kill an exact pane and report a tmux refusal rather than swallowing it', async () => {
    // Arrange
    const killed = new FakeTmux([ok()]);
    const refused = new FakeTmux([{ code: 1, stdout: '', stderr: "can't find pane: %12\n" }]);
    const silent = new FakeTmux([{ code: 1, stdout: '', stderr: '   ' }]);

    // Act
    await new TmuxController(killed).killPaneExact('%12');

    // Assert
    should(killed.received).deepEqual([['kill-pane', '-t', '%12']]);
    await should(new TmuxController(refused).killPaneExact('%12')).rejectedWith("can't find pane: %12");
    await should(new TmuxController(silent).killPaneExact('%12')).rejectedWith('tmux could not kill the pane');
  });
});
