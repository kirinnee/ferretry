import { describe, it } from 'bun:test';
import { INPUT_MAX_REDACTION_SECONDS } from '@ferretry/protocol';
import should from 'should';
import { EphemeralValues } from '../../../src/lib/input-requests/ephemeral-values.ts';

const clock = { ms: 1_000_000 };
const build = () => new EphemeralValues({ now: () => clock.ms });

describe('EphemeralValues', () => {
  it('should mask a held value for one session only, longest value first', () => {
    const values = build();
    values.hold('s1', 'abc', 'A1');
    values.hold('s1', 'abcdef', 'A2');

    should(values.scrub('s1', 'x abcdef y abc')).equal('x [redacted:input A2] y [redacted:input A1]');
    should(values.scrub('s2', 'abc')).equal('abc');
    should(values.scrubAll('abc')).equal('[redacted:input A1]');
  });

  it('should hold nothing for an empty value', () => {
    const values = build();
    values.hold('s1', '', 'A1');

    should(values.heldCount()).equal(0);
  });

  it('should REPLACE the stored arrays on a prune, so an expired value is no longer reachable', () => {
    const values = build();
    values.hold('s1', 'old-value', 'A1', 10);
    values.hold('s1', 'new-value', 'A2', 100);
    clock.ms += 50_000;
    values.purge();

    should(values.heldCount('s1')).equal(1);
    should(values.scrub('s1', 'old-value new-value')).equal('old-value [redacted:input A2]');
    should(JSON.stringify([...values.sessions()])).not.containEql('old-value');
    clock.ms += 100_000;
    values.purge();
    should(values.sessions()).eql([]);
    should(values.heldCount()).equal(0);
  });

  it('should purge on a hold, a scrub and a scrubAll without anyone calling purge', () => {
    const values = build();
    values.hold('s1', 'gone-soon', 'A1', 5);
    clock.ms += 6_000;
    values.hold('s2', 'fresh', 'A2');
    should(values.heldCount('s1')).equal(0);

    values.hold('s3', 'gone-soon-too', 'A3', 5);
    clock.ms += 6_000;
    should(values.scrub('s3', 'gone-soon-too')).equal('gone-soon-too');
    values.hold('s4', 'again', 'A4', 5);
    clock.ms += 6_000;
    should(values.scrubAll('again')).equal('again');
    should(values.heldCount()).equal(1);
  });

  it('should cap the window and drop a whole session when it ends', () => {
    const values = build();
    values.hold('s1', 'capped', 'A1', INPUT_MAX_REDACTION_SECONDS * 100);
    values.hold('s1', 'short', 'A2', 0);
    clock.ms += INPUT_MAX_REDACTION_SECONDS * 1000 + 1;

    should(values.scrub('s1', 'capped')).equal('capped');
    values.hold('s1', 'again', 'A3');
    values.drop('s1');
    values.drop('never-held');
    should(values.heldCount('s1')).equal(0);
    should(values.heldCount('never-held')).equal(0);
  });
});

describe('EphemeralValues.fragments', () => {
  it('should say yes for a line ending with the start of a held value, or starting with its end', () => {
    const values = build();
    values.hold('s1', 'hunter2-UNIQUE', 'A1');

    should(values.fragments('s1', 'Password: hunter2-UN')).be.true();
    should(values.fragments('s1', 'IQUE rest of the line')).be.true();
  });

  it('should say no for an ordinary line, for fewer than three characters, for the whole value and for another session', () => {
    const values = build();
    values.hold('s1', 'hunter2-UNIQUE', 'A1');

    should(values.fragments('s1', '[sudo] password for kirin:')).be.false();
    should(values.fragments('s1', 'Password: hu')).be.false();
    should(values.fragments('s1', 'Password: hunter2-UNIQUE')).be.false();
    should(values.fragments('s2', 'Password: hunter2-UN')).be.false();
  });

  it('should count half of a value shorter than six characters as a piece of it, and forget an expired value', () => {
    const values = build();
    values.hold('s1', 'ab', 'A1');
    values.hold('s1', 'gone-value', 'A2', 1);
    clock.ms += 5_000;

    should(values.fragments('s1', 'xa')).be.true();
    should(values.fragments('s1', 'xb')).be.false();
    should(values.fragments('s1', 'gone-val')).be.false();
  });
});
