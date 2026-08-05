import { describe, expect, test } from 'bun:test';

import {
  composerEnterAction,
  composerEnterHint,
  shiftedComposerEnterAction,
} from '../../src/lib/composer-keybinding.ts';

describe('composer keybinding', () => {
  test('uses a different default for desktop keyboards and touch devices', () => {
    expect(composerEnterAction(null, true)).toBe('send');
    expect(composerEnterAction(null, false)).toBe('newline');
  });

  test('keeps an explicit device-local choice and its keyboard alternative reachable', () => {
    expect(composerEnterAction('send', false)).toBe('send');
    expect(shiftedComposerEnterAction('send')).toBe('newline');
    expect(composerEnterAction('newline', true)).toBe('newline');
    expect(shiftedComposerEnterAction('newline')).toBe('send');
  });

  test('never claims Shift is available on a touch-affected device', () => {
    expect(composerEnterHint('newline', true)).toBe('Enter for a new line · use Send to send');
    expect(composerEnterHint('send', true)).toBe('Enter to send · use New line for a new line');
    expect(composerEnterHint('send', false)).toContain('Shift+Enter');
  });
});
