import { describe, expect, test } from 'bun:test';
import { PANE_EXIT_FACTS, parsePaneExits } from '../../../../daemon/lib/tmux/pane-exit.ts';

describe('parsePaneExits', () => {
  test('asks for the pane id, dead, and how the program ended', () => {
    expect(PANE_EXIT_FACTS).toBe('#{pane_id}|#{pane_dead}|#{pane_dead_status}|#{pane_dead_signal}');
  });

  test('a live pane has no status and no signal', () => {
    expect(parsePaneExits('%3|0||\n')).toEqual([{ paneId: '%3', dead: false }]);
  });

  test('a program that exited carries its status, 0 included', () => {
    expect(parsePaneExits('%3|1|0|\n%4|1|137|\n')).toEqual([
      { paneId: '%3', dead: true, status: 0 },
      { paneId: '%4', dead: true, status: 137 },
    ]);
  });

  test('a program a signal ended carries the signal and no status', () => {
    expect(parsePaneExits('%3|1||9\n')).toEqual([{ paneId: '%3', dead: true, signal: 9 }]);
  });

  test('a signal of 0 is none, and a line that does not parse is dropped, never read as live or dead', () => {
    expect(parsePaneExits('%3|1|2|0\nnonsense\n%x|1||\n%5|2||\n|1||\n')).toEqual([
      { paneId: '%3', dead: true, status: 2 },
    ]);
  });
});
