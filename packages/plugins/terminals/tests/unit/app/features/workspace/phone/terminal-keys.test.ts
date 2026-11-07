import { describe, expect, it } from 'bun:test';
import {
  applyStickyCtrl,
  controlCharacter,
  terminalKeySequence,
} from '../../../../../src/features/workspace/phone/terminal-keys.ts';

describe('terminalKeySequence', () => {
  it('sends esc, tab and the four arrows', () => {
    expect(terminalKeySequence('esc')).toBe('\x1b');
    expect(terminalKeySequence('tab')).toBe('\t');
    expect(terminalKeySequence('up')).toBe('\x1b[A');
    expect(terminalKeySequence('down')).toBe('\x1b[B');
    expect(terminalKeySequence('right')).toBe('\x1b[C');
    expect(terminalKeySequence('left')).toBe('\x1b[D');
  });

  it('sends the modifier-5 form for ctrl+arrow and leaves esc and tab alone', () => {
    expect(terminalKeySequence('left', true)).toBe('\x1b[1;5D');
    expect(terminalKeySequence('up', true)).toBe('\x1b[1;5A');
    expect(terminalKeySequence('esc', true)).toBe('\x1b');
    expect(terminalKeySequence('tab', true)).toBe('\t');
  });
});

describe('controlCharacter', () => {
  it('masks letters in either case to the low five bits', () => {
    expect(controlCharacter('c')).toBe('\x03');
    expect(controlCharacter('C')).toBe('\x03');
    expect(controlCharacter('a')).toBe('\x01');
    expect(controlCharacter('z')).toBe('\x1a');
  });

  it('maps the punctuation terminals give control forms', () => {
    expect(controlCharacter('@')).toBe('\x00');
    expect(controlCharacter('[')).toBe('\x1b');
    expect(controlCharacter('\\')).toBe('\x1c');
    expect(controlCharacter(']')).toBe('\x1d');
    expect(controlCharacter('^')).toBe('\x1e');
    expect(controlCharacter('_')).toBe('\x1f');
    expect(controlCharacter(' ')).toBe('\x00');
    expect(controlCharacter('?')).toBe('\x7f');
  });

  it('has no control form for digits, other punctuation or a longer chunk', () => {
    expect(controlCharacter('1')).toBeNull();
    expect(controlCharacter('!')).toBeNull();
    expect(controlCharacter('{')).toBeNull();
    expect(controlCharacter('ab')).toBeNull();
    expect(controlCharacter('')).toBeNull();
  });
});

describe('applyStickyCtrl', () => {
  it('passes input through when ctrl is not armed', () => {
    expect(applyStickyCtrl('c', false)).toBe('c');
  });

  it('turns one armed key into its control character', () => {
    expect(applyStickyCtrl('c', true)).toBe('\x03');
  });

  it('sends a paste or a key without a control form as typed', () => {
    expect(applyStickyCtrl('hello', true)).toBe('hello');
    expect(applyStickyCtrl('1', true)).toBe('1');
  });
});
