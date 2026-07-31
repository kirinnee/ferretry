import { describe, it } from 'bun:test';
import should from 'should';
import { verdictBlocksMigration, worstVerdict } from '../../../src/lib/migrate/verdict.ts';

describe('migration verdict policy', () => {
  it('should rank destructive work above unknown and safe work', () => {
    // Act
    const verdict = worstVerdict(['safe_to_kill', 're_armable', 'unknown', 'destructive_to_interrupt']);

    // Assert
    should(verdict).equal('destructive_to_interrupt');
  });

  it('should refuse unclassified or destructive work by default', () => {
    // Act + Assert
    should(verdictBlocksMigration('safe_to_kill')).be.false();
    should(verdictBlocksMigration('re_armable')).be.false();
    should(verdictBlocksMigration('unknown')).be.true();
    should(verdictBlocksMigration('destructive_to_interrupt')).be.true();
  });
});
