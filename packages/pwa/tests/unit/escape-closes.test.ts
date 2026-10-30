import { describe, expect, test } from 'bun:test';
import { escapeCloses } from '../../src/lib/escape-closes.ts';

const press = (key: string, init: { defaultPrevented?: boolean; isComposing?: boolean } = {}) => {
  let prevented = false;
  let closed = 0;
  escapeCloses(() => {
    closed += 1;
  })({
    key,
    defaultPrevented: init.defaultPrevented ?? false,
    nativeEvent: { isComposing: init.isComposing ?? false },
    preventDefault: () => {
      prevented = true;
    },
  });
  return { prevented, closed };
};

describe('escapeCloses', () => {
  test('closes on a bare Escape and takes the key', () => {
    expect(press('Escape')).toEqual({ prevented: true, closed: 1 });
  });

  test('leaves any other key alone', () => {
    expect(press('Enter')).toEqual({ prevented: false, closed: 0 });
  });

  test('leaves an Escape the field already used (a completion list, Vim mode)', () => {
    expect(press('Escape', { defaultPrevented: true })).toEqual({ prevented: false, closed: 0 });
  });

  test('leaves an Escape that cancels an input-method composition', () => {
    expect(press('Escape', { isComposing: true })).toEqual({ prevented: false, closed: 0 });
  });
});
