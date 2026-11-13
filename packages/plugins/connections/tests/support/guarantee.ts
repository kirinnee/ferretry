/**
 * THE guarantee helper: one body shared by several Appendix D rows. `guarantee([ID_ONE, ID_TWO], 'holds', run)` runs one
 * `it` titled "<ID_ONE> holds" and one titled "<ID_TWO> holds", so the runtime titles lead with a row id and JUnit sees
 * each row. (No example here may spell a real row id inside an `it(` call: the title scanner reads this file too, and a
 * made-up unit-tier test of an integration row is exactly what it would then count.)
 *
 * `scripts/validate/guarantees.ts` and `parity-ticks.ts` count a call of THIS function (named `guarantee`, imported from
 * `tests/support/guarantee.ts`) as one test per listed id, and nothing else: keep the ids literal strings, and never
 * declare another function of this name in a test file.
 */
import { it } from 'bun:test';

export function guarantee(ids: readonly string[], name: string, run: Parameters<typeof it>[1]): void {
  for (const id of ids) it(`${id} ${name}`, run);
}
