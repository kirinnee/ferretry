import { expect, test } from 'bun:test';
import { parsePaneWatch } from '../../../../daemon/lib/session/peers/tmux.ts';

test('a pane watch reading says whether the pane is dead and when it last had activity', () => {
  expect(parsePaneWatch('0 1730000000\n')).toEqual({ dead: false, activityAt: 1_730_000_000 });
  expect(parsePaneWatch('  1 42 ')).toEqual({ dead: true, activityAt: 42 });
});

test('a pane watch reading that is not "<0|1> <seconds>" answers nothing', () => {
  for (const reading of ['', '2 10', '0', '0 ten', '0 10 extra', 'dead 10'])
    expect(parsePaneWatch(reading)).toBeUndefined();
});
