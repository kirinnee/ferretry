import { describe, expect, it } from 'bun:test';
import {
  isCaptureEscapeChord,
  isKeyboardCaptured,
  KEYBOARD_CAPTURE_ATTRIBUTE,
} from '../../src/lib/keyboard-capture.ts';

const chord = (overrides: Partial<Parameters<typeof isCaptureEscapeChord>[0]> = {}) => ({
  key: 'Escape',
  shiftKey: true,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  ...overrides,
});

describe('isKeyboardCaptured', () => {
  it('is true for a target inside a surface that carries the marker', () => {
    expect(KEYBOARD_CAPTURE_ATTRIBUTE).toBe('data-keyboard-capture');
    const seen: string[] = [];
    const target = {
      closest(selector: string) {
        seen.push(selector);
        return {};
      },
    };
    expect(isKeyboardCaptured(target as unknown as EventTarget)).toBe(true);
    expect(seen).toEqual(['[data-keyboard-capture]']);
  });

  it('is false for anything that cannot prove it is inside one', () => {
    expect(isKeyboardCaptured(null)).toBe(false);
    expect(isKeyboardCaptured(undefined)).toBe(false);
    expect(isKeyboardCaptured('window' as unknown as EventTarget)).toBe(false);
    expect(isKeyboardCaptured({} as EventTarget)).toBe(false);
    expect(isKeyboardCaptured({ closest: () => null } as unknown as EventTarget)).toBe(false);
  });

  it('works on a real element, including one nested below the marker', () => {
    const owner = document.createElement('div');
    owner.setAttribute(KEYBOARD_CAPTURE_ATTRIBUTE, '');
    const child = document.createElement('textarea');
    owner.appendChild(child);
    expect(isKeyboardCaptured(child)).toBe(true);
    expect(isKeyboardCaptured(document.createElement('div'))).toBe(false);
  });
});

describe('isCaptureEscapeChord', () => {
  it('is exactly Shift+Escape', () => {
    expect(isCaptureEscapeChord(chord())).toBe(true);
    expect(isCaptureEscapeChord(chord({ shiftKey: false }))).toBe(false);
    expect(isCaptureEscapeChord(chord({ key: 'a' }))).toBe(false);
    expect(isCaptureEscapeChord(chord({ ctrlKey: true }))).toBe(false);
    expect(isCaptureEscapeChord(chord({ altKey: true }))).toBe(false);
    expect(isCaptureEscapeChord(chord({ metaKey: true }))).toBe(false);
  });
});
