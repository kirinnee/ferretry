import { describe, expect, test } from 'bun:test';
import { renderFerret, renderSessionTable } from '../../../../cli/lib/session/display.ts';
import { sessionView } from './session-fixtures.ts';

const PLAIN = { amber: (text: string) => text } as Parameters<typeof renderSessionTable>[1];

describe('a stopped ferret says why it ended', () => {
  test('status: a signal, with its last words under it', () => {
    const lines = renderFerret(
      sessionView({ state: 'stopped', cause: { kind: 'signal', signal: 9, lastLines: 'out of memory\nKilled' } }),
    );
    expect(lines.slice(3)).toEqual([
      '  ended: the agent was killed by signal 9',
      '  its last words:',
      '    out of memory',
      '    Killed',
    ]);
  });

  test('status: an exit code, a clean exit and a lost terminal each say so', () => {
    expect(renderFerret(sessionView({ state: 'stopped', cause: { kind: 'agent_crashed', exitCode: 2 } })).at(-1)).toBe(
      '  ended: the agent exited with code 2',
    );
    expect(renderFerret(sessionView({ state: 'stopped', cause: { kind: 'clean_exit' } })).at(-1)).toBe(
      '  ended: the agent exited on its own (exit code 0)',
    );
    expect(renderFerret(sessionView({ state: 'stopped', cause: { kind: 'terminal_gone' } })).at(-1)).toBe(
      '  ended: its terminal ended and how it ended was not recorded',
    );
  });

  test('status: a stop, a finish, a live ferret and a launch that never ran add nothing', () => {
    for (const view of [
      sessionView({ state: 'stopped', cause: { kind: 'stopped' } }),
      sessionView({ state: 'stopped', cause: { kind: 'completed' } }),
      sessionView({ state: 'stopped', cause: { kind: 'start_failed' } }),
      sessionView({ state: 'stopped' }),
      sessionView({ state: 'working' }),
    ])
      expect(renderFerret(view)).toHaveLength(3);
  });

  test('status: a crashed terminal server says so', () => {
    expect(renderFerret(sessionView({ state: 'stopped', cause: { kind: 'tmux_crashed' } })).at(-1)).toBe(
      '  ended: its terminal server crashed',
    );
  });

  test('ps: the STATE cell carries the reason in a few words', () => {
    const rows = renderSessionTable(
      [
        sessionView({ id: 'a', state: 'stopped', cause: { kind: 'signal', signal: 9 } }),
        sessionView({ id: 'b', state: 'stopped', cause: { kind: 'stopped' } }),
      ],
      PLAIN,
    );
    expect(rows[1]).toContain('stopped (signal 9)');
    expect(rows[2]).not.toContain('(');
  });

  test('ps: every end nobody chose is a few words in the STATE cell, and a stop is just stopped', () => {
    const causes = [
      [{ kind: 'agent_crashed', exitCode: 3 }, 'stopped (exit 3)'],
      [{ kind: 'clean_exit' }, 'stopped (exited)'],
      [{ kind: 'tmux_crashed' }, 'stopped (terminal crashed)'],
      [{ kind: 'terminal_gone' }, 'stopped (terminal gone)'],
      [{ kind: 'stopped' }, 'stopped'],
    ] as const;
    const rows = renderSessionTable(
      causes.map(([cause], at) => sessionView({ id: `r${at}`, state: 'stopped', cause })),
      PLAIN,
    );
    for (const [at, [, cell]] of causes.entries()) expect(rows[at + 1]).toContain(cell);
  });
});
