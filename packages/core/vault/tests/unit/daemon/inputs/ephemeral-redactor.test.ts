import { describe, it } from 'bun:test';
import should from 'should';
import { EphemeralAwareRedactor } from '../../../../daemon/lib/inputs/ephemeral-redactor.ts';
import { EphemeralValues } from '../../../../daemon/lib/inputs/ephemeral-values.ts';
import { NO_REDACTION, SecretRedactor, type TextRedactor } from '../../../../daemon/lib/secrets/redaction.ts';

const values = new EphemeralValues({ now: () => 1 });
values.hold('s1', 'JUST-TYPED', 'A1');

const vault = new SecretRedactor({ values: async () => new Map([['VAULT', 'VAULT']]) });

describe('EphemeralAwareRedactor', () => {
  it('should apply the just-typed values and the vault to original text', async () => {
    const redactor = new EphemeralAwareRedactor(vault, values);

    should(await redactor.redact('JUST-TYPED and VAULT')).equal('[redacted:input A1] and [redacted:VAULT]');
  });

  it('should mask every string and key inside data, and leave other values alone', async () => {
    const redactor = new EphemeralAwareRedactor(NO_REDACTION, values);
    const out = await redactor.redactData({
      'JUST-TYPED': ['x JUST-TYPED', 3, null, true],
      nested: { v: 'JUST-TYPED' },
    });

    should(out).eql({
      '[redacted:input A1]': ['x [redacted:input A1]', 3, null, true],
      nested: { v: '[redacted:input A1]' },
    });
  });

  it('should mask inside a batch under one vault open, for text and for data', async () => {
    const redactor = new EphemeralAwareRedactor(vault, values);
    const [text, data] = await redactor.batch(scrub => [
      scrub.text('a JUST-TYPED b VAULT'),
      scrub.data({ k: 'JUST-TYPED' }),
    ]);

    should(text).equal('a [redacted:input A1] b [redacted:VAULT]');
    should(data).eql({ k: '[redacted:input A1]' });
  });

  it('I102 should mask a vault secret that overlaps a just-typed value as one run, whichever store is read first', async () => {
    const overlapping = new EphemeralValues({ now: () => 1 });
    overlapping.hold('s1', 'defgh', 'A1');
    const redactor = new EphemeralAwareRedactor(
      new SecretRedactor({ values: async () => new Map([['VAULT', 'abcdef']]) }),
      overlapping,
    );

    should(await redactor.redact('x abcdefgh y')).equal('x [redacted] y');
    should(await redactor.redactData({ abcdefgh: ['abcdefgh'] })).eql({ '[redacted]': ['[redacted]'] });
  });

  it('should cover the union of both stores by position', async () => {
    const redactor = new EphemeralAwareRedactor(vault, values);

    should(await redactor.batch(scrub => scrub.cover('VAULT JUST-TYPED'))).eql([
      { start: 0, end: 5 },
      { start: 6, end: 16 },
    ]);
  });

  it('I102 masks original cut prefixes that contain a whole typed value', async () => {
    const typed = new EphemeralValues({ now: () => 1 });
    typed.hold('s1', 'fixture-secret', '!A0');
    const redactor = new EphemeralAwareRedactor(
      new SecretRedactor({ values: async () => new Map([['TOKEN', 'prefix-fixture-secret-suffix']]) }),
      typed,
    );
    should(await redactor.batch(scrub => scrub.text('prefix-fixture-secret', true))).equal('[redacted]');
  });

  it('I102 retains typed and sealed labels for cut prefixes and does not mask replacement text', async () => {
    const typed = new EphemeralValues({ now: () => 1 });
    typed.hold('s1', 'fixture-secret', '!A0');
    typed.hold('s1', 'redacted', '!A1');
    typed.holdUntil('s1', 'copy-fixture-value', '[sealed:copy]', 10_000);
    const redactor = new EphemeralAwareRedactor(NO_REDACTION, typed);
    should(await redactor.batch(scrub => scrub.text('fixture-sec', true))).equal('[redacted:input !A0]');
    should(await redactor.batch(scrub => scrub.text('copy-fixt', true))).equal('[sealed:copy]');
    should(await redactor.redact('fixture-secret')).equal('[redacted:input !A0]');
  });

  it('should fail exactly as the vault does when it cannot be opened', async () => {
    const broken: TextRedactor = {
      redact: async () => Promise.reject(new Error('vault locked')),
      redactData: async () => Promise.reject(new Error('vault locked')),
      batch: async () => Promise.reject(new Error('vault locked')),
    };
    const redactor = new EphemeralAwareRedactor(broken, values);

    await should(redactor.redact('x')).be.rejectedWith('vault locked');
  });
});
