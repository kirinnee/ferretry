import { describe, it } from 'bun:test';
import should from 'should';
import {
  COMPACTION_GLYPHS,
  COMPACTION_SHAPES,
  COMPACTION_TEXTS,
  compactionFrame,
  NOT_COMPACTION_LINES,
} from '../../../../../../../std/tests/support/compaction-shapes.ts';
import { paneCompaction } from '../../../../../daemon/lib/session/live/compaction.ts';

/**
 * &B188: the shared table of every Claude compaction status shape (`@ferretry/std`'s `tests/support/compaction-shapes.ts`),
 * run through Ferrets' `paneCompaction`. The terminals plugin's pane readers and the send policy run the same table, so
 * a shape one sees and another misses cannot let a send be typed into a compacting composer.
 */
describe('B188 the shared compaction shape table, read by paneCompaction', () => {
  it('covers every spinner tick on every status text', () => {
    should(COMPACTION_SHAPES).have.length(COMPACTION_GLYPHS.length * COMPACTION_TEXTS.length);
  });

  for (const shape of COMPACTION_SHAPES)
    it(`reads "${shape.line}" as a compaction (${shape.source})`, () => {
      should(paneCompaction(compactionFrame(shape.line))).not.be.undefined();
    });

  it('reads a carriage-return framed shape the same', () => {
    for (const shape of COMPACTION_SHAPES) {
      const frame = compactionFrame(shape.line).replaceAll('\n', '\r\n');

      should([shape.line, paneCompaction(frame) !== undefined]).deepEqual([shape.line, true]);
    }
  });

  for (const line of NOT_COMPACTION_LINES)
    it(`does not read "${line}" as a compaction`, () => {
      should(paneCompaction(compactionFrame(line))).be.undefined();
    });
});
