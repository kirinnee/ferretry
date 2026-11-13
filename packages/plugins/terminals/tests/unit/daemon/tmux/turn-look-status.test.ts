/** U5: the status lines a `Runner.look` carries for the live readout. */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUNNER_LOOK_STATUS_BYTES } from '@ferretry/core-ferrets/contract';
import { paneStateFrom } from '../../../../daemon/lib/tmux/pane.ts';
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

describe('B188 the turn look reads a compaction as status work, not as an overrulable spinner', () => {
  const visible = readFileSync(
    join(import.meta.dir, '../../../fixtures/composer/claude-2.1.30x-compacting-start-middot.txt'),
    'utf8',
  );

  test('B188 a · tick compaction is working, never spinner-only, and not at the prompt', () => {
    const look = turnLookOf({ dead: false, alive: true, promptReady: false, history: '', visible }, text => text);
    expect(look.working).toBe(true);
    expect(look.spinnerOnly).toBeUndefined();
    expect(look.atPrompt).toBe(false);
  });
});

describe('B187 the turn look reads an idle composer that holds a draft', () => {
  const fixture = (name: string): string =>
    readFileSync(join(import.meta.dir, '../../../fixtures/composer', name), 'utf8');
  const stateOf = (visible: string, promptReady: boolean) => ({
    dead: false,
    alive: true,
    promptReady,
    history: '',
    visible,
  });

  test('B187 atPrompt is true for an idle composer holding a draft, promptReady stays false', () => {
    const visible = fixture('claude-2.1.30x-idle-compacted-draft.txt');
    const pane = paneStateFrom(
      { dead: false, cursorX: 36, cursorY: 9, height: 24, width: 80, exitCode: 0 } as never,
      visible,
    );
    expect(pane.promptReady).toBe(false);
    expect(turnLookOf(pane, text => text).atPrompt).toBe(true);
  });

  test('B187 a working line, a dead pane, a dialog or no composer at all is not at the prompt', () => {
    const idle = fixture('claude-2.1.30x-idle-draft-quote.txt');
    const working = idle.replace('✻ Worked for 4m 2s · done 10:03 AM', '✻ Pondering… (3s · esc to interrupt)');
    expect(turnLookOf(stateOf(working, false), text => text).atPrompt).toBe(false);
    expect(turnLookOf({ ...stateOf(idle, false), dead: true }, text => text).atPrompt).toBe(false);
    expect(
      turnLookOf(stateOf('Do you trust the contents of this directory?\n❯ 1. Yes\n  2. No\n', false), text => text)
        .atPrompt,
    ).toBe(false);
    expect(turnLookOf(stateOf('just some output\n', false), text => text).atPrompt).toBe(false);
    expect(
      turnLookOf(stateOf('Request interrupted\n› \n  tell the model what to do differently', false), text => text)
        .atPrompt,
    ).toBe(true);
  });
});
