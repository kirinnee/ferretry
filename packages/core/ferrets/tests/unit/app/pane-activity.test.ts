import { describe, expect, test } from 'bun:test';
import { paneActivityDetail, parsePaneActivity } from '../../src/lib/pane-activity.ts';

const frame = (...lines: string[]): string => lines.join('\n');

describe('parsePaneActivity', () => {
  test('reads Claude’s spinner verb, clock and token counter', () => {
    const activity = parsePaneActivity(
      frame(
        '● Read(packages/daemon/src/lib/fleet-login/service.ts)',
        '  ⎿  Read 512 lines',
        '',
        '✽ Pontificating… (42s · ↓ 3.1k tokens · esc to interrupt)',
        '',
        '> ',
      ),
    );
    expect(activity).toEqual({ harness: 'claude', verb: 'Pontificating…', elapsed: '42s', tokens: '↓ 3.1k tokens' });
    expect(paneActivityDetail(activity as NonNullable<typeof activity>)).toBe('42s · ↓ 3.1k tokens');
  });

  test('keeps a multi-word verb and a minutes clock, and survives a clipped parenthetical', () => {
    expect(parsePaneActivity('✻ Fixing stall detection… (5m 45s · esc to')).toEqual({
      harness: 'claude',
      verb: 'Fixing stall detection…',
      elapsed: '5m 45s',
    });
    expect(parsePaneActivity('✢ Thinking…')).toEqual({ harness: 'claude', verb: 'Thinking…' });
  });

  test('reads Codex’s working line', () => {
    expect(parsePaneActivity(frame('• Working (6m52s • Esc to interrupt)', '› '))).toEqual({
      harness: 'codex',
      verb: 'Working…',
      elapsed: '6m52s',
    });
  });

  test('refuses bullets and prose that only look like a status line', () => {
    expect(parsePaneActivity('• Plan (step one)')).toBeNull();
    expect(parsePaneActivity('I was thinking… about it')).toBeNull();
    expect(parsePaneActivity('* Pontificating… (1s)')).toBeNull();
    expect(parsePaneActivity('')).toBeNull();
  });

  test('prefers the lowest line and ignores a spinner that has scrolled out of the status window', () => {
    const old = '✻ Old verb… (1s)';
    expect(parsePaneActivity(frame(old, ...Array.from({ length: 30 }, () => 'output')))).toBeNull();
    expect(parsePaneActivity(frame(old, '✳ New verb… (2s)\r'))).toMatchObject({ verb: 'New verb…' });
  });

  test('prints nothing extra when the harness printed no numbers', () => {
    expect(paneActivityDetail({ harness: 'claude', verb: 'Thinking…' })).toBe('');
  });
});
