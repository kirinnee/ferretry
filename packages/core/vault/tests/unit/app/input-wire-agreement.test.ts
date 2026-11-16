/**
 * The app half keeps its own pad function and value check, because an app half may not import the daemon's wire file.
 * Two programs that must agree on a fact need one test that fails when they stop (docs/standards/fact-ownership): this
 * pins the app's copy to the daemon's for every length the daemon takes, in plain and multi-byte text.
 */
import { describe, expect, it } from 'bun:test';
import { INPUT_VALUE_MAX_BYTES } from '../../../contract/index.ts';
import {
  inputValueProblem as daemonProblem,
  padInputValue as daemonPad,
  unpadInputValue,
} from '../../../daemon/lib/inputs/wire.ts';
import { inputValueProblem, padInputValue } from '../../../app/lib/input-wire.ts';

describe('the app’s input wire copy agrees with the daemon’s', () => {
  it('pads every length the daemon takes to the same bucket, and the daemon reads it back', () => {
    for (let length = 1; length <= INPUT_VALUE_MAX_BYTES; length += 1) {
      const value = 'x'.repeat(length);
      const padded = padInputValue(value);
      expect(padded).toBe(daemonPad(value));
      expect(unpadInputValue(padded)).toBe(value);
    }
  });

  it('pads multi-byte text by its bytes, as the daemon does', () => {
    for (const value of ['pässwörd', '密码密码', 'a😀b', 'é'.repeat(300)]) {
      expect(padInputValue(value)).toBe(daemonPad(value));
      expect(unpadInputValue(padInputValue(value))).toBe(value);
    }
  });

  it('refuses a value over the limit as the daemon does', () => {
    const over = 'x'.repeat(INPUT_VALUE_MAX_BYTES + 1);
    expect(() => padInputValue(over)).toThrow(RangeError);
    expect(() => daemonPad(over)).toThrow(RangeError);
  });

  it('judges a value fit to type the same way for every sensitivity', () => {
    const samples = ['', 'ok', 'tab\there', 'line\nbreak', 'bell\u0007', 'x'.repeat(INPUT_VALUE_MAX_BYTES + 1), '😀'];
    for (const sensitivity of ['secret', 'private', 'code', 'plain'] as const)
      for (const value of samples)
        expect(inputValueProblem(value, sensitivity)).toBe(daemonProblem(value, sensitivity));
  });
});
