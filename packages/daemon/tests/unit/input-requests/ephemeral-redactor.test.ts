import { describe, it } from 'bun:test';
import should from 'should';
import { EphemeralAwareRedactor } from '../../../src/lib/input-requests/ephemeral-redactor.ts';
import { EphemeralValues } from '../../../src/lib/input-requests/ephemeral-values.ts';
import { NO_REDACTION, type TextRedactor } from '../../../src/lib/secrets/redaction.ts';

const values = new EphemeralValues({ now: () => 1 });
values.hold('s1', 'JUST-TYPED', 'A1');

const vault: TextRedactor = {
  redact: async text => text.replaceAll('VAULT', '[vault]'),
  redactData: async value => JSON.parse(JSON.stringify(value).replaceAll('VAULT', '[vault]')) as unknown,
  batch: async work => work({ text: text => text.replaceAll('VAULT', '[vault]'), data: value => value }),
};

describe('EphemeralAwareRedactor', () => {
  it('should apply the just-typed values and then the vault to text', async () => {
    const redactor = new EphemeralAwareRedactor(vault, values);

    should(await redactor.redact('JUST-TYPED and VAULT')).equal('[redacted:input A1] and [vault]');
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

    should(text).equal('a [redacted:input A1] b [vault]');
    should(data).eql({ k: '[redacted:input A1]' });
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
