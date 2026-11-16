import { describe, it } from 'bun:test';
import should from 'should';
import { claudeFastSupport } from '../../../daemon/lib/service/foreign.ts';

/** The catalog's `fast` flag for every Claude model comes from this rule (catalog.ts), so it is pinned here (no guarantees row). */
describe('claudeFastSupport (no guarantees row)', () => {
  it('is offered on opus-4-8 and opus-5 ids, in any case, selector or not', () => {
    should(
      ['claude-opus-5-5', 'claude-opus-5', 'CLAUDE-OPUS-5-5[1m]', 'claude-opus-4-8'].map(claudeFastSupport),
    ).deepEqual([true, true, true, true]);
  });

  it('is not offered on other models', () => {
    should(['claude-opus-4-6', 'claude-sonnet-5-5', 'claude-haiku-5-5'].map(claudeFastSupport)).deepEqual([
      false,
      false,
      false,
    ]);
  });
});
