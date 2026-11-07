import { describe, it } from 'bun:test';
import should from 'should';
import { age, escapeCell, truncate, verdictLabels } from '../../../src/lib/migrate/render-text.ts';

describe('migration report text helpers', () => {
  it('should scale an age to the unit a reader can act on', () => {
    // Act + Assert
    should(age(0)).equal('0s');
    should(age(89)).equal('89s');
    should(age(90)).equal('2m');
    should(age(5399)).equal('90m');
    should(age(5400)).equal('2h');
  });

  it('should render an unmeasurable age as unknown rather than as zero', () => {
    // Act + Assert
    should(age(undefined)).equal('?');
    should(age(Number.NaN)).equal('?');
    should(age(Number.POSITIVE_INFINITY)).equal('?');
  });

  it('should collapse a long multi-line command onto one bounded line', () => {
    // Act + Assert
    should(truncate('  git   commit\n  -m work  ', 90)).equal('git commit -m work');
    should(truncate('abcdefghij', 5)).equal('abcd…');
    should(truncate('abcde', 5)).equal('abcde');
  });

  it('should keep a pipe in a value from splitting the markdown cell it sits in', () => {
    // Act + Assert
    should(escapeCell('rg TODO | wc -l')).equal('rg TODO \\| wc -l');
    should(escapeCell('  spaced\tout\n')).equal('spaced out');
  });

  it('should shout only about the two verdicts that must not be skimmed past', () => {
    // Act + Assert
    should(verdictLabels).deepEqual({
      safe_to_kill: 'safe',
      re_armable: 're-armable',
      destructive_to_interrupt: 'DESTRUCTIVE',
      unknown: 'UNKNOWN',
    });
  });
});
