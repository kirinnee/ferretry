import { describe, expect, it } from 'bun:test';
import { validateDictationShortcut } from '../../../../src/features/settings/dictation-shortcut.ts';

const BROWSER = 'standard browser command';
const OPERATING_SYSTEM = 'operating system reserves';

describe('validateDictationShortcut — chords a page can never own', () => {
  it('refuses Command or Control plus a browser-owned letter', () => {
    expect(validateDictationShortcut({ code: 'KeyT', key: 't', modifiers: ['Meta'] }).reason).toContain(BROWSER);
    expect(validateDictationShortcut({ code: 'KeyW', key: 'w', modifiers: ['Control'] }).reason).toContain(BROWSER);
  });

  it('allows that same letter once another modifier makes the chord distinct', () => {
    expect(validateDictationShortcut({ code: 'KeyT', key: 't', modifiers: ['Meta', 'Shift'] })).toEqual({ ok: true });
  });

  it('refuses the window-manager chords the operating system consumes first', () => {
    expect(validateDictationShortcut({ code: 'Tab', key: 'Tab', modifiers: ['Alt'] }).reason).toContain(
      OPERATING_SYSTEM,
    );
    expect(validateDictationShortcut({ code: 'F4', key: 'F4', modifiers: ['Alt'] }).reason).toContain(OPERATING_SYSTEM);
    expect(validateDictationShortcut({ code: 'Space', key: ' ', modifiers: ['Meta'] }).reason).toContain(
      OPERATING_SYSTEM,
    );
    expect(
      validateDictationShortcut({ code: 'Delete', key: 'Delete', modifiers: ['Control', 'Alt'] }).reason,
    ).toContain(OPERATING_SYSTEM);
  });
});
