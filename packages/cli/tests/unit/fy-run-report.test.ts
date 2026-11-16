import { describe, expect, test } from 'bun:test';
import { describeFyRun, expectFyExit, MASK, masked, TAIL_BYTES, tail } from '../integration/support/fy-run-report.ts';

const TOKEN = 'fixture-admin-token-0123456789';

describe('what a failed fy run says about itself', () => {
  test('a run that exited as expected is returned untouched', () => {
    const run = { code: 0, out: '{}', err: '' };
    expect(expectFyExit(['delta', 'show'], run, 0, [TOKEN])).toBe(run);
  });

  test('a run that exited otherwise throws naming the argv, both codes, stderr and stdout', () => {
    const run = { code: 1, out: 'partial answer', err: 'fy: the daemon refused' };
    expect(() => expectFyExit(['delta', 'show'], run, 0, [TOKEN])).toThrow(
      '`fy delta show` exited 1, expected 0\n--- stderr ---\nfy: the daemon refused\n--- stdout ---\npartial answer',
    );
  });

  test('an empty stream is said to be empty', () => {
    expect(describeFyRun(['x'], { code: 2, out: '', err: '' }, [], 0)).toContain(
      '--- stderr ---\n(empty)\n--- stdout ---\n(empty)',
    );
  });

  test('every secret the fixture holds is masked, wherever it appears', () => {
    const run = { code: 1, out: `out ${TOKEN}`, err: `401 for ${TOKEN}; Authorization: Bearer abc.def-ghi ${TOKEN}` };
    const text = describeFyRun(['delta', 'show'], run, [TOKEN], 0);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('abc.def-ghi');
    expect(text).toContain(`Bearer ${MASK}`);
    expect(text).toContain(`401 for ${MASK}`);
  });

  test('an empty secret masks nothing (it must not split the text between every character)', () => {
    expect(masked('abc', [''])).toBe('abc');
  });

  test('only the last TAIL_BYTES of a long stream are kept, and the cut is said', () => {
    const long = `${'a'.repeat(TAIL_BYTES)}THE-END`;
    const kept = tail(long);
    expect(kept).toContain('THE-END');
    expect(kept).toContain('7 earlier bytes cut');
    expect(Buffer.byteLength(kept.slice(kept.indexOf('\n') + 1))).toBe(TAIL_BYTES);
  });

  test('a stream within the bound is kept whole', () => {
    expect(tail('short')).toBe('short');
  });

  test('a secret that straddles the cut is masked, never half shown', () => {
    const err = `${TOKEN}${'z'.repeat(TAIL_BYTES - 5)}`;
    expect(describeFyRun(['x'], { code: 1, out: '', err }, [TOKEN], 0)).not.toContain(TOKEN.slice(-6));
  });
});
