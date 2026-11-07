import { describe, expect, test } from 'bun:test';

import { composerEnterAction, shiftedComposerEnterAction } from '../../../src/compose/composer-keybinding.ts';

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
});
