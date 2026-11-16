import { describe, it } from 'bun:test';
import should from 'should';
import { COMPACTING_LINE } from '../../src/compaction-line.ts';
import {
  COMPACTION_GLYPHS,
  COMPACTION_SHAPES,
  COMPACTION_TEXTS,
  NOT_COMPACTION_LINES,
} from '../support/compaction-shapes.ts';

/**
 * &B188: the ONE Claude compaction line grammar, run over the shared shape table. The readers' own tests run the same
 * table through their frames; this one pins the grammar itself, line by line.
 */
describe('B188 the shared Claude compaction line grammar', () => {
  it('B188 the shape table covers every spinner tick on every status text', () => {
    should(COMPACTION_SHAPES).have.length(COMPACTION_GLYPHS.length * COMPACTION_TEXTS.length);
  });

  for (const shape of COMPACTION_SHAPES)
    it(`B188 accepts "${shape.line}" (${shape.source})`, () => {
      should(COMPACTING_LINE.test(shape.line)).be.true();
    });

  for (const line of NOT_COMPACTION_LINES)
    it(`B188 rejects "${line}"`, () => {
      should(COMPACTING_LINE.test(line)).be.false();
    });

  it('B188 accepts the interrupt-only parenthetical in BOTH ellipses', () => {
    should(COMPACTING_LINE.test('✢ Compacting conversation… (esc to interrupt)')).be.true();
    should(COMPACTING_LINE.test('✢ Compacting conversation... (esc to interrupt)')).be.true();
  });

  it('B188 never runs across a line break: whitespace is not newline', () => {
    should(COMPACTING_LINE.test('·\nCompacting conversation…')).be.false();
    should(COMPACTING_LINE.test('· Compacting conversation…\n(3s)')).be.true();
    should(COMPACTING_LINE.test('· Compacting conversation… (\n3s)')).be.false();
  });

  it('B188 is anchored to the start of a line, so prose that carries the words does not match', () => {
    should(COMPACTING_LINE.test('  ✢ Compacting conversation…')).be.true();
    should(COMPACTING_LINE.test('we were · Compacting conversation…')).be.false();
    should(COMPACTING_LINE.test('│ · Compacting conversation… │')).be.false();
  });
});
