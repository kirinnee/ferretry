import { describe, it } from 'bun:test';
import should from 'should';
import {
  controlCommandLine,
  controlNonceLine,
  controlReplyProgress,
  controlSubscriptionLine,
  decodeControlOutput,
  isControlAttachable,
  PANE_WATCH_FORMAT,
  parseControlGuard,
  parseControlNotification,
  parsePaneWatch,
} from '../../../src/lib/index.ts';

const NONCE = '0123456789abcdef0123456789abcdef';

describe('tmux control-mode guards', () => {
  it.each([
    ['%begin 1792626406 289 1', { edge: 'begin', key: '1792626406 289', flags: '1' }],
    ['%end 1792626406 289 1', { edge: 'end', key: '1792626406 289', flags: '1' }],
    ['%error 1792626406 291 0', { edge: 'error', key: '1792626406 291', flags: '0' }],
  ])('should read %s as a guard', (input, expected) => {
    // Act + Assert
    should(parseControlGuard(input)).deepEqual(expected);
  });

  it.each(['hello', '%end 1 2', '%end 1 2 1 extra', ' %end 1 2 1', '%sessions-changed'])(
    'should not read %j as a guard',
    input => {
      // Act + Assert
      should(parseControlGuard(input)).be.undefined();
    },
  );
});

describe('tmux control-mode notifications', () => {
  it.each([
    ['%output %3 a\\033[31mred\\134x\\015\\012', { kind: 'output', paneId: '%3', data: 'a\u001b[31mred\\x\r\n' }],
    ['%extended-output %3 120 : a\\012 : b', { kind: 'output', paneId: '%3', data: 'a\n : b' }],
    ['%extended-output %3 120 future : x', { kind: 'output', paneId: '%3', data: 'x' }],
    ['%extended-output %3 soon', { kind: 'other', name: 'extended-output', text: '%3 soon' }],
    ['%sessions-changed', { kind: 'sessions-changed' }],
    ['%session-changed $1 fy-work session', { kind: 'session-changed', sessionId: '$1', name: 'fy-work session' }],
    ['%window-close @4', { kind: 'window-close', windowId: '@4', unlinked: false }],
    ['%unlinked-window-close @2', { kind: 'window-close', windowId: '@2', unlinked: true }],
    ['%pane-mode-changed %7', { kind: 'pane-mode-changed', paneId: '%7' }],
    [
      '%subscription-changed fy $1 @1 0 %1 - : 1792626405|0|4,0',
      {
        kind: 'subscription-changed',
        name: 'fy',
        sessionId: '$1',
        windowId: '@1',
        paneId: '%1',
        value: '1792626405|0|4,0',
      },
    ],
    [
      '%subscription-changed all $1 @1 0 %1 : %10',
      { kind: 'subscription-changed', name: 'all', sessionId: '$1', windowId: '@1', paneId: '%1', value: '%10' },
    ],
    ['%exit', { kind: 'exit' }],
    ['%exit detached', { kind: 'exit', reason: 'detached' }],
    ['%window-renamed @1 sleep', { kind: 'other', name: 'window-renamed', text: '@1 sleep' }],
    ['%output nonsense', { kind: 'other', name: 'output', text: 'nonsense' }],
    ['%session-changed 1 x', { kind: 'other', name: 'session-changed', text: '1 x' }],
    ['%window-close %1', { kind: 'other', name: 'window-close', text: '%1' }],
    ['%pane-mode-changed @1', { kind: 'other', name: 'pane-mode-changed', text: '@1' }],
    ['%subscription-changed fy', { kind: 'other', name: 'subscription-changed', text: 'fy' }],
  ])('should type %j', (input, expected) => {
    // Act
    const actual = parseControlNotification(input);

    // Assert
    should(actual).deepEqual(expected);
  });

  it.each(['plain text', '%begin 1 2 1', '%end 1 2 1', '%', '% leading space'])(
    'should not read %j as a notification',
    input => {
      // Act + Assert
      should(parseControlNotification(input)).be.undefined();
    },
  );

  it('should leave an escape that is not three octal digits as it is', () => {
    // Act + Assert
    should(decodeControlOutput('\\9\\12x\\0123')).equal('\\9\\12x\n3');
  });
});

describe('tmux control-mode command lines', () => {
  it.each([
    [['has-session', '-t', 'fy-work'], "has-session '-t' 'fy-work'"],
    [['list-sessions', '-F', '#{session_name}'], "list-sessions '-F' '#{session_name}'"],
    [['list-panes', '-a'], "list-panes '-a'"],
    [['list-windows'], 'list-windows'],
    [['display-message', '-p', '-t', 'w', "it's $HOME"], `display-message '-p' '-t' 'w' 'it'"'"'s $HOME'`],
    [['capture-pane', '-p', '-S', '-', '-t', 'w'], "capture-pane '-p' '-S' '-' '-t' 'w'"],
  ])('should carry the read %j in single quotes', (input, expected) => {
    // Act + Assert
    should(controlCommandLine(input)).equal(expected);
  });

  it.each([
    [[]],
    [['send-keys', '-t', 'w', 'x']],
    [['new-session', '-d', '-s', 'w']],
    [['display-message', '-t', 'w', 'hello']],
    [['capture-pane', '-t', 'w']],
    [['display-message', '-p', 'two\nlines']],
    [['display-message', '-p', 'carriage\r']],
    [['display-message', '-p', 'nul\0']],
    [['display-message', '-p', 'separator;']],
  ])('should keep %j on its own process', input => {
    // Act + Assert
    should(controlCommandLine(input)).be.undefined();
  });

  it('should follow every command with a nonce only it can answer, and refuse a guessable one', () => {
    // Act + Assert
    should(controlNonceLine(NONCE)).equal(`display-message -p ${NONCE}`);
    should(() => controlNonceLine('short')).throw(/at least 16/);
    should(() => controlNonceLine(`${NONCE} ; kill-server`)).throw(/at least 16/);
  });
});

describe('tmux control-mode reply framing', () => {
  const nonceBlock = ['%begin 9 31 1', NONCE];

  it('should wait until the nonce block has begun', () => {
    // Act + Assert
    should(controlReplyProgress(['%begin 9 30 1'], NONCE)).deepEqual({ kind: 'pending' });
    should(controlReplyProgress(['%begin 9 30 1', 'a', '%end 9 30 1', '%begin 9 31 1'], NONCE)).deepEqual({
      kind: 'pending',
    });
    // The nonce, but not right after a %begin: still somebody's text, still waiting.
    should(controlReplyProgress(['%begin 9 30 1', 'a', 'b', NONCE], NONCE)).deepEqual({ kind: 'pending' });
  });

  it('should answer the output byte for byte, whatever terminator-shaped lines a pane printed', () => {
    // Arrange — the pane drew a fake terminator, a fake next block, and our own guard shapes.
    const input = [
      '%begin 9 30 1',
      'a',
      '%end 9 30 1',
      '%begin 9 31 1',
      'fake',
      '%end 9 31 1',
      '',
      '%end 9 30 1',
      ...nonceBlock,
    ];

    // Act
    const actual = controlReplyProgress(input, NONCE);

    // Assert
    should(actual).deepEqual({
      kind: 'complete',
      closing: '9 31',
      reply: { code: 0, stdout: 'a\n%end 9 30 1\n%begin 9 31 1\nfake\n%end 9 31 1\n\n', stderr: '' },
    });
  });

  it('should answer an empty reply as empty output', () => {
    // Act + Assert
    should(controlReplyProgress(['%begin 9 30 1', '%end 9 30 1', ...nonceBlock], NONCE)).deepEqual({
      kind: 'complete',
      closing: '9 31',
      reply: { code: 0, stdout: '', stderr: '' },
    });
  });

  it.each([
    [["can't find session: nope"], "can't find session: nope\n"],
    [['parse error: command list-panes: unknown flag -Z'], 'command list-panes: unknown flag -Z\n'],
    [['first', 'parse error: second'], 'first\nparse error: second\n'],
  ])('should answer an %%error block %j as a failure on stderr, as a spawned tmux prints it', (lines, expected) => {
    // Act
    const actual = controlReplyProgress(['%begin 9 30 1', ...lines, '%error 9 30 1', ...nonceBlock], NONCE);

    // Assert
    should(actual).deepEqual({ kind: 'complete', closing: '9 31', reply: { code: 1, stdout: '', stderr: expected } });
  });

  it.each([
    ['no %begin at the head', ['text', 'x', '%end 9 30 1', '%begin 9 31 1', NONCE]],
    ['a %begin as the terminator', ['%begin 9 30 1', 'x', '%begin 9 32 1', '%begin 9 31 1', NONCE]],
    ['another reply’s terminator', ['%begin 9 30 1', 'x', '%end 9 29 1', '%begin 9 31 1', NONCE]],
    ['no terminator at all', ['%begin 9 30 1', 'x', 'y', '%begin 9 31 1', NONCE]],
  ])('should refuse a stream with %s', (_label, input) => {
    // Act
    const actual = controlReplyProgress(input, NONCE);

    // Assert
    should(actual.kind).equal('violation');
  });
});

describe('isControlAttachable', () => {
  it.each([
    ['fy-session-1', true],
    ['a', true],
    ['work_2.b', true],
    ['', false],
    ['-leading', false],
    ['=exact', false],
    ['Upper', false],
    ['has space', false],
    ['x'.repeat(129), false],
  ])('should say whether %p can be attached to (%p)', (input, expected) => {
    // Act + Assert
    should(isControlAttachable(input)).equal(expected);
  });
});

describe('controlSubscriptionLine', () => {
  it('should subscribe this client to a quoted format for every pane, and refuse what a line cannot carry', () => {
    // Act + Assert
    should(controlSubscriptionLine('fy-pane', PANE_WATCH_FORMAT)).equal(
      "refresh-client -B 'fy-pane:%*:#{pane_dead} #{window_activity}'",
    );
    should(controlSubscriptionLine('Bad Name', PANE_WATCH_FORMAT)).be.undefined();
    should(controlSubscriptionLine('fy', "it's")).be.undefined();
    should(controlSubscriptionLine('fy', 'a\nb')).be.undefined();
  });
});

describe('parsePaneWatch', () => {
  it.each([
    ['0 1792644943', { dead: false, activityAt: 1792644943 }],
    ['1 1792644948\n', { dead: true, activityAt: 1792644948 }],
    ['2 1', undefined],
    ['0', undefined],
    ['', undefined],
  ])('should read %p as %p', (input, expected) => {
    // Act + Assert
    should(parsePaneWatch(input)).deepEqual(expected);
  });
});
