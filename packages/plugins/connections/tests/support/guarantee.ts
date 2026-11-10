/**
 * THE guarantee helper: one body shared by several Appendix D rows. `guarantee(['R42', 'R43'], 'holds', run)` runs one
 * `it('R42 holds')` and one `it('R43 holds')`, so the runtime titles lead with a row id and JUnit sees each row.
 *
 * `scripts/validate/guarantees.ts` and `parity-ticks.ts` count a call of THIS function (named `guarantee`, imported from
 * `tests/support/guarantee.ts`) as one test per listed id, and nothing else: keep the ids literal strings, and never
 * declare another function of this name in a test file.
 */
import { it } from 'bun:test';

export function guarantee(ids: readonly string[], name: string, run: Parameters<typeof it>[1]): void {
  for (const id of ids) it(`${id} ${name}`, run);
}
