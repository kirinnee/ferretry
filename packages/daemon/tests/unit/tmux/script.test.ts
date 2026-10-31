import { describe, it } from 'bun:test';
import should from 'should';
import { carriesPayload, scriptArguments, scriptLine } from '../../../src/lib/tmux/script.ts';

describe('which tmux commands travel on stdin', () => {
  it('should send a new-session that sets environment, and every send-keys, on stdin', () => {
    // A pane's credential and typed keys are payloads; the process listing must never show them.
    should(
      carriesPayload(['new-session', '-d', '-s', 'fy-a', '-e', 'FY_SESSION_BOARD_CAPABILITY=cap', 'agent']),
    ).be.true();
    should(carriesPayload(['send-keys', '-H', '-t', '%1', '70', '61'])).be.true();
    should(carriesPayload(['send-keys', '-t', 'fy-a', '-l', 'hunter2'])).be.true();
  });

  it('should send the guarded write — an if-shell -F whose branch types the value — and every if-shell, on stdin', () => {
    should(
      carriesPayload(['if-shell', '-F', '-t', '%1', '#{==:#{pane_dead},0}', 'send-keys -H -t %1 70', 'x']),
    ).be.true();
    should(carriesPayload(['if-shell', '-t', '%1', 'true', 'display-message hi'])).be.true();
  });

  it('should send every payload-bearing tmux command on stdin, under its name or its alias', () => {
    // tmux's own family, not today's callers: the next caller of any of these is covered already.
    for (const command of [
      'send-keys',
      'send',
      'set-buffer',
      'setb',
      'set-environment',
      'setenv',
      'if-shell',
      'if',
      'run-shell',
      'run',
    ])
      should(carriesPayload([command, 'x'])).be.true(command);
    for (const command of [
      'new-session',
      'new',
      'new-window',
      'neww',
      'split-window',
      'splitw',
      'respawn-pane',
      'respawnp',
      'respawn-window',
      'respawnw',
    ])
      should(carriesPayload([command, '-e', 'K=V', 'cmd'])).be.true(command);
  });

  it('should judge a compound command by every command in it, not only the first', () => {
    should(carriesPayload(['display-message', '-p', 'x', ';', 'send-keys', '-l', 'hunter2'])).be.true();
    should(carriesPayload(['list-sessions', ';', 'set-option', 'a', 'b'])).be.false();
    should(scriptArguments(['set-option', 'a', 'b', ';', 'new', '-e', 'K=V'])).deepEqual([
      'start-server',
      ';',
      'source-file',
      '-',
    ]);
  });

  it('should leave addresses and reads in argv, including a new-session with no environment', () => {
    should(carriesPayload(['new-session', '-d', '-s', 'fy-webterm-a', '-c', '/w', '/bin/zsh', '-l'])).be.false();
    should(carriesPayload(['capture-pane', '-p', '-t', 'fy-a'])).be.false();
    should(carriesPayload([])).be.false();
  });

  it('should start the server only for new-session, which may be the command that creates it', () => {
    should(scriptArguments(['new-session', '-e', 'A=1'])).deepEqual(['start-server', ';', 'source-file', '-']);
    should(scriptArguments(['send-keys', '-l', 'x'])).deepEqual(['source-file', '-']);
  });
});

describe('a tmux command as one script line', () => {
  it('should single-quote every argument so tmux expands nothing', () => {
    should(scriptLine(['send-keys', '-l', '$HOME ~ #{pane_id} #x ;y \\'])).equal(
      "'send-keys' '-l' '$HOME ~ #{pane_id} #x ;y \\'\n",
    );
  });

  it('should carry a single quote, an empty argument and a trailing semicolon literally', () => {
    should(scriptLine(['send-keys', '-l', "it's", '', 'ls;'])).equal(`'send-keys' '-l' 'it'"'"'s' '' 'ls;'\n`);
  });

  it('should write newlines and carriage returns as escaped segments of the same argument', () => {
    should(scriptLine(['new-session', '-e', 'A=one\ntwo\r\n'])).equal(
      `'new-session' '-e' 'A=one'"\\n"'two'"\\r""\\n"\n`,
    );
    should(scriptLine(['x', '\n'])).equal(`'x' "\\n"\n`);
  });

  it('should keep a lone semicolon as the separator argv would have read it as', () => {
    should(scriptLine(['set-option', 'a', ';', 'set-option', 'b'])).equal("'set-option' 'a' ; 'set-option' 'b'\n");
  });

  it('should refuse a NUL, which no argument can carry either', () => {
    should(() => scriptLine(['send-keys', '-l', 'a\0b'])).throw(/NUL/u);
  });
});
