import { describe, it } from 'bun:test';
import should from 'should';
import { COPY_AFTER_MASK_SECONDS, COPY_MAX_LIFETIME_SECONDS } from '../../../../daemon/lib/inputs/borrowed.ts';
import { EphemeralAwareRedactor } from '../../../../daemon/lib/inputs/ephemeral-redactor.ts';
import { EphemeralValues } from '../../../../daemon/lib/inputs/ephemeral-values.ts';
import { NO_REDACTION } from '../../../../daemon/lib/secrets/redaction.ts';

/** Never a real credential. */
const SENTINEL = 'FAKE-SC-7f3a91';
const MARKER = '[sealed:token]';
const HOUR = 3_600_000;
const AFTER = COPY_AFTER_MASK_SECONDS * 1000;
const clock = { ms: 1_000_000 };
const build = () => new EphemeralValues({ now: () => clock.ms });

describe('a value pasted into a terminal stays masked for the scrollback’s life, not the copy’s', () => {
  it('should keep masking after the copy’s own mask (expiry plus ten minutes) has ended, which a plain copy does not', () => {
    const values = build();
    const expiry = clock.ms + HOUR;
    values.holdUntil('s1', 'plain-copy-value', '[sealed:plain]', expiry + AFTER);
    values.holdUntil('s1', SENTINEL, MARKER, expiry + AFTER);
    values.holdScrollback('s1', SENTINEL, MARKER);

    clock.ms = expiry + AFTER + 1;

    should(values.scrub('s1', `screen: ${SENTINEL} plain-copy-value`)).equal(`screen: ${MARKER} plain-copy-value`);
  });

  it('should keep masking for days (the longest a copy lives is hours)', () => {
    const values = build();
    values.holdScrollback('s1', SENTINEL, MARKER);

    clock.ms += (COPY_MAX_LIFETIME_SECONDS + 100 * 24 * 3600) * 1000;

    should(values.scrub('s1', SENTINEL)).equal(MARKER);
    should(values.heldCount('s1')).equal(1);
  });

  it('should not be shortened by the copy being discarded (a retime of its marker)', () => {
    const values = build();
    values.holdUntil('s1', SENTINEL, MARKER, clock.ms + HOUR);
    values.holdScrollback('s1', SENTINEL, MARKER);

    values.retime('s1', MARKER, clock.ms + 1_000);
    clock.ms += 5_000;

    should(values.scrub('s1', SENTINEL)).equal(MARKER);
    should(values.heldCount('s1')).equal(1);
  });

  it('should be masked for one session only, and hold nothing for an empty value', () => {
    const values = build();
    values.holdScrollback('s1', SENTINEL, MARKER);
    values.holdScrollback('s1', '', MARKER);

    should(values.scrub('s2', SENTINEL)).equal(SENTINEL);
    should(values.heldCount('s1')).equal(1);
  });

  it('should hold one value once however often it is pasted', () => {
    const values = build();
    for (let paste = 0; paste < 5; paste += 1) values.holdScrollback('s1', SENTINEL, MARKER);

    should(values.heldCount('s1')).equal(1);
  });

  it('should end ten minutes after the session does, the same window as any copy', () => {
    const values = build();
    values.holdScrollback('s1', SENTINEL, MARKER);

    values.drop('s1');
    should(values.scrub('s1', SENTINEL)).equal(MARKER);
    clock.ms += AFTER + 1;

    should(values.scrub('s1', SENTINEL)).equal(SENTINEL);
    should(values.heldCount()).equal(0);
  });

  it('should keep every value of a session masked up to a bound, letting go of the OLDEST past it', () => {
    const values = build();
    for (let index = 0; index < 300; index += 1)
      values.holdScrollback('s1', `value-${String(index).padStart(4, '0')}`, MARKER);

    should(values.heldCount('s1')).equal(256);
    should(values.scrub('s1', 'value-0000 value-0299')).equal(`value-0000 ${MARKER}`);
  });

  it('should mask in every read the daemon scrubs: text, data and by position (a screen cell by cell)', async () => {
    const values = build();
    values.holdScrollback('s1', SENTINEL, MARKER);
    clock.ms += 10 * 24 * 3600 * 1000;
    const redactor = new EphemeralAwareRedactor(NO_REDACTION, values);

    const [text, data, covered] = await redactor.batch(scrub => [
      scrub.text(`$ echo ${SENTINEL}`),
      scrub.data({ tail: [`${SENTINEL}`] }),
      scrub.cover(`x ${SENTINEL}`),
    ]);

    should(text).equal(`$ echo ${MARKER}`);
    should(data).eql({ tail: [MARKER] });
    should(covered).eql([{ start: 2, end: 2 + SENTINEL.length }]);
  });
});
