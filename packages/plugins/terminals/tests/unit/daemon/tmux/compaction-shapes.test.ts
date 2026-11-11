import { describe, it } from 'bun:test';
import should from 'should';
import {
  COMPACTION_GLYPHS,
  COMPACTION_SHAPES,
  COMPACTION_TEXTS,
  compactionFrame,
  NOT_COMPACTION_LINES,
} from '../../../../../../std/tests/support/compaction-shapes.ts';
import {
  idlePromptShown,
  paneActiveWork,
  paneShowsCompacting,
  promptIsReady,
} from '../../../../daemon/lib/tmux/pane.ts';

/**
 * &B188: one table of every Claude compaction status shape (`@ferretry/std`'s `tests/support/compaction-shapes.ts`),
 * run through the terminals plugin's pane readers. Ferrets' `paneCompaction` and the send policy run the same table in
 * their own tests. `✢ Compacting conversation... (esc to interrupt)` once slipped between the readers: one saw it, the
 * other did not, and a parked session's send was typed into the compacting composer.
 */
describe('B188 the shared compaction shape table, read by the terminals pane readers', () => {
  it('covers every spinner tick on every status text', () => {
    should(COMPACTION_SHAPES).have.length(COMPACTION_GLYPHS.length * COMPACTION_TEXTS.length);
  });

  for (const shape of COMPACTION_SHAPES)
    it(`reads "${shape.line}" as a compaction (${shape.source})`, () => {
      const frame = compactionFrame(shape.line);

      should(paneShowsCompacting(frame)).be.true();
      should(paneActiveWork(frame)).equal('status');
      should(promptIsReady(frame)).be.false();
      should(idlePromptShown(frame)).be.false();
    });

  it('reads a carriage-return framed shape the same', () => {
    for (const shape of COMPACTION_SHAPES) {
      const frame = compactionFrame(shape.line).replaceAll('\n', '\r\n');

      should([shape.line, paneShowsCompacting(frame)]).deepEqual([shape.line, true]);
    }
  });
});

describe('B188 lines that only mention compaction', () => {
  for (const line of NOT_COMPACTION_LINES)
    it(`does not read "${line}" as a compaction`, () => {
      const frame = compactionFrame(line);

      should(paneShowsCompacting(frame)).be.false();
      // A line that carries the harness's own interrupt hint is work on that evidence alone, compaction or not.
      if (!line.includes('esc to interrupt')) {
        should(paneActiveWork(frame)).be.undefined();
        should(idlePromptShown(frame)).be.true();
      }
    });
});
