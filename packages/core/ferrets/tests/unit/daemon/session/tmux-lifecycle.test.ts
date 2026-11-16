import { describe, expect, test } from 'bun:test';
import {
  hasSessionArguments,
  harnessExitReason,
  isTmuxServerAbsent,
  PANE_PROOF_FORMAT,
  paneProofArguments,
  parsePaneSighting,
  provePane,
  resolveSessionTarget,
  sessionTarget,
} from '../../../../daemon/lib/session/peers/tmux-lifecycle.ts';

describe('a tmux session address', () => {
  test('is a lowercase name of letters, digits, dots, dashes and underscores, and is passed through', () => {
    expect(sessionTarget('fy-wren_1.a')).toBe('fy-wren_1.a');
    expect(hasSessionArguments('fy-wren')).toEqual(['has-session', '-t', 'fy-wren']);
  });

  test('is refused when it could be read by tmux as a pattern, a window, a flag or an empty name', () => {
    for (const unsafe of ['', 'Upper', '-leading', 'a:b', 'a.b:c', 'glob*', 'with space', 'x'.repeat(129)])
      expect(() => sessionTarget(unsafe)).toThrow('session must be a lowercase tmux name');
    expect(() => hasSessionArguments('A')).toThrow('session must be a lowercase tmux name');
  });
});

describe('whether tmux refused because no server runs', () => {
  test('is true for each measured phrasing of an absent server', () => {
    expect(isTmuxServerAbsent('no server running on /tmp/tmux-1000/default')).toBe(true);
    expect(isTmuxServerAbsent('error connecting to /tmp/tmux-1000/default (No such file or directory)')).toBe(true);
    expect(isTmuxServerAbsent('failed to connect to server')).toBe(true);
  });

  test('is false for a server that went away mid-request and for any other failure', () => {
    expect(isTmuxServerAbsent('server exited unexpectedly')).toBe(false);
    expect(isTmuxServerAbsent("can't find session: fy-wren")).toBe(false);
    expect(isTmuxServerAbsent('')).toBe(false);
  });
});

describe('proving which pane this is', () => {
  test('asks tmux for the proof format of the named session', () => {
    expect(paneProofArguments('fy-wren')).toEqual(['display-message', '-p', '-t', 'fy-wren', PANE_PROOF_FORMAT]);
  });

  test('reads a live pane with its pid and creation second', () => {
    expect(parsePaneSighting('%12|4242|0|1730000000\n')).toEqual({
      paneId: '%12',
      dead: false,
      pid: 4242,
      sessionCreated: 1_730_000_000,
    });
  });

  test('reads a dead pane on tmux 3.8, which prints no pid, and a pane with no creation second', () => {
    expect(parsePaneSighting('%0||1|1730000000')).toEqual({ paneId: '%0', dead: true, sessionCreated: 1_730_000_000 });
    expect(parsePaneSighting('%3|77|0|')).toEqual({ paneId: '%3', dead: false, pid: 77 });
  });

  test('refuses anything that is not a pane tmux described', () => {
    for (const output of [
      '',
      '%1|2|0',
      '%1|2|0|3|4',
      '1|2|0|3',
      '%01|2|0|3',
      '%1|2|2|3',
      '%1|1|0|3',
      '%1|0|0|3',
      '%1|007|0|3',
      '%1|abc|0|3',
      `%1|${'9'.repeat(20)}|0|3`,
    ])
      expect(parsePaneSighting(output)).toBeUndefined();
  });

  const stamp = { paneId: '%5', pid: 900, sessionCreated: 1_700 };

  test('proves the same pane by id, creation second and pid', () => {
    expect(provePane({ paneId: '%5', pid: 900, dead: false, sessionCreated: 1_700 }, stamp)).toBe('proven');
  });

  test('proves a dead pane that prints no pid when its id and creation second match', () => {
    expect(provePane({ paneId: '%5', dead: true, sessionCreated: 1_700 }, stamp)).toBe('proven');
  });

  test('refutes another pane id, another creation second, another pid, and a live pane with no pid', () => {
    expect(provePane({ paneId: '%6', pid: 900, dead: false, sessionCreated: 1_700 }, stamp)).toBe('refuted');
    expect(provePane({ paneId: '%5', pid: 900, dead: false, sessionCreated: 1_701 }, stamp)).toBe('refuted');
    expect(provePane({ paneId: '%5', pid: 901, dead: false, sessionCreated: 1_700 }, stamp)).toBe('refuted');
    expect(provePane({ paneId: '%5', dead: false, sessionCreated: 1_700 }, stamp)).toBe('refuted');
    expect(provePane({ paneId: '%5', pid: 900, dead: false }, stamp)).toBe('refuted');
  });
});

describe('resolving a session name the way tmux does', () => {
  test('takes the session of exactly that name, even when it is also a prefix of others', () => {
    expect(resolveSessionTarget('fy-a', ['fy-ab', 'fy-a', 'fy-ac'])).toBe('fy-a');
  });

  test('takes the one session the name is a prefix of', () => {
    expect(resolveSessionTarget('fy-w', ['other', 'fy-wren'])).toBe('fy-wren');
  });

  test('is nothing when no session matches or the prefix is ambiguous', () => {
    expect(resolveSessionTarget('fy-x', ['fy-a', 'fy-b'])).toBeUndefined();
    expect(resolveSessionTarget('fy-a', ['fy-ab', 'fy-ac'])).toBeUndefined();
    expect(resolveSessionTarget('fy-a', [])).toBeUndefined();
  });
});

describe('why a pane is gone', () => {
  test('says the exit status and quotes the last three lines of what it printed', () => {
    expect(harnessExitReason({ exitCode: 2, visible: 'one\ntwo\nthree\nfour\n' })).toBe(
      'the interactive harness exited (2): its last output was "two / three / four"',
    );
  });

  test('says tmux kept no exit code when it reported none, and says no more when nothing was printed', () => {
    expect(harnessExitReason({ visible: '\n  \nPane is dead (status 0)\n' })).toBe(
      'the interactive harness exited; tmux reported no exit code',
    );
  });

  test('reads the scrollback when there is one, and the visible rows when it is blank', () => {
    expect(harnessExitReason({ exitCode: 1, visible: 'on screen', history: 'in history' })).toContain('"in history"');
    expect(harnessExitReason({ exitCode: 1, visible: 'on screen', history: '  \n' })).toContain('"on screen"');
  });

  test('drops colour codes and control characters so nothing reaches a surface that renders the reason', () => {
    const reason = harnessExitReason({ exitCode: 1, visible: '\u001b[31mred error\u001b[0m\u0007 bell\u0000' });
    expect(reason).toBe('the interactive harness exited (1): its last output was "red error bell"');
  });

  test('keeps only the last 300 characters of a runaway line, marked with an ellipsis', () => {
    const reason = harnessExitReason({ exitCode: 1, visible: `${'a'.repeat(400)}END` });
    const quoted = /"(.*)"$/u.exec(reason)?.[1] ?? '';
    expect(quoted.startsWith('…')).toBe(true);
    expect(quoted.endsWith('END')).toBe(true);
    expect(quoted).toHaveLength(301);
  });
});
