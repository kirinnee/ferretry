/**
 * The SPEED/SIZE half of `../../../unit/daemon/secrets/read-scope.test.ts` (F-0326 #U4): the cost of masking a busy
 * screen. The masks themselves are unit's, at a small size.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { coverageOf } from '../../../../daemon/lib/secrets/policy.ts';
import { maskGrid, maskLines, VaultRedaction } from '../../../../daemon/lib/secrets/read-scope.ts';
import { counted, dense, PIN, source } from '../../../unit/daemon/secrets/read-scope-fixtures.ts';

describe('F-0326 #U4 the cost of masking a busy screen', () => {
  it('F-0326 #U4 lines read each match range a bounded number of times, never once per character', () => {
    // Arrange — 50 rows of 200: 2,000 ranges over 10,000 characters.
    const lines = Array.from({ length: 50 }, () => dense(200));
    let probe: ReturnType<typeof counted> | undefined;
    const cover = (text: string) => {
      probe = counted(coverageOf(text, [PIN]));
      return probe.ranges;
    };

    // Act
    const masked = maskLines(lines, [PIN], cover);

    // Assert — the same mask, at a cost in range reads of the ranges themselves, not of ranges × characters.
    should(masked).deepEqual(lines.map(() => '**** '.repeat(40)));
    should(probe?.ranges.length).equal(2000);
    should(probe?.reads()).be.belowOrEqual(2 * 2000);
  });

  it('F-0326 #U4 cells read each match range a bounded number of times, never once per cell', () => {
    // Arrange — 50 rows of 200 one-character cells.
    const grid = { columns: 200, rows: Array.from({ length: 50 }, () => [...dense(200)]) };
    let probe: ReturnType<typeof counted> | undefined;
    const cover = (text: string) => {
      probe = counted(coverageOf(text, [PIN]));
      return probe.ranges;
    };

    // Act
    const masked = maskGrid(grid, [PIN], cover);

    // Assert
    should(masked.rows.map(row => row.join(''))).deepEqual(grid.rows.map(() => '**** '.repeat(40)));
    should(probe?.reads()).be.belowOrEqual(2 * 2000);
  });

  it('F-0326 #U4 a 200×2000 screen dense with a 4-character value masks inside the 2 s stop bound', async () => {
    // Arrange — 80,000 matches over 400,000 characters, the size of a pane an attached client stretched.
    const redaction = new VaultRedaction(source({ PIN }));
    const rows = Array.from({ length: 200 }, () => dense(2000));

    // Act
    const started = performance.now();
    const masked = await redaction.read(scope => scope.lines(rows));
    const took = performance.now() - started;

    // Assert — synchronous masking inside a read must leave the stop's 2 s bound able to fire.
    should(masked.every(row => row === '**** '.repeat(400))).be.true();
    should(took).be.below(2000);
  });
});
