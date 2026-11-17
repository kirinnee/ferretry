import { describe, expect, test } from 'bun:test';
import { lastLinesOf, PANE_EXIT_FACTS, parsePaneExits } from '../../../../daemon/lib/tmux/pane-exit.ts';

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

describe('lastLinesOf', () => {
  test('keeps the last non-empty lines of a screen, trailing blanks and padding gone', () => {
    expect(lastLinesOf('a   \n\n\nb\n\n   \nc  \n\n\n')).toBe('a\nb\nc');
  });

  test('at most the last 8 lines', () => {
    const screen = Array.from({ length: 12 }, (_, at) => `line ${at + 1}`).join('\n');
    expect(lastLinesOf(screen)).toBe(Array.from({ length: 8 }, (_, at) => `line ${at + 5}`).join('\n'));
  });

  test('at most the last 600 characters', () => {
    const lines = lastLinesOf(`${'x'.repeat(500)}\n${'y'.repeat(500)}`);
    expect(lines?.length).toBeLessThanOrEqual(600);
    expect(lines?.endsWith('y'.repeat(500))).toBe(true);
  });

  test('a screen that shows nothing says nothing', () => {
    expect(lastLinesOf('\n  \n\n')).toBeUndefined();
  });
});
