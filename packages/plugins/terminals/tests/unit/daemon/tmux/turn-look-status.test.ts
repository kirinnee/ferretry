/** U5: the status lines a `Runner.look` carries for the live readout. */
import { describe, expect, test } from 'bun:test';
import { RUNNER_LOOK_STATUS_BYTES } from '@ferretry/core-ferrets/contract';
import { statusLinesOf, turnLookOf } from '../../../../daemon/lib/tmux/turn-look.ts';

const frame = (lines: number): string => Array.from({ length: lines }, (_, index) => `line ${index + 1}`).join('\n');

describe('U5 status lines (what the live readout reads from a look)', () => {
  test('a look carries only the last 25 lines of the masked frame, bounded in size, and none for a blank frame', () => {
    const status = statusLinesOf(frame(100)) ?? '';
    expect(status.split('\n')).toHaveLength(25);
    expect(status.endsWith('line 100')).toBe(true);
    expect(statusLinesOf('x'.repeat(RUNNER_LOOK_STATUS_BYTES * 3))?.length).toBe(RUNNER_LOOK_STATUS_BYTES);
    expect(statusLinesOf('\n  \n')).toBeUndefined();
  });

  test('the status of a look is the lines of the frame it was given, which is already masked', () => {
    const look = turnLookOf(
      { dead: false, alive: true, promptReady: false, history: '', visible: '✻ Pondering… (3s · esc to interrupt)' },
      text => `digest:${text.length}`,
    );
    expect(look.status).toBe('✻ Pondering… (3s · esc to interrupt)');
  });
});
