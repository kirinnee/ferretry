import { describe, it } from 'bun:test';
import should from 'should';
import {
  InputAuditDetailSchema,
  InputCodeKeySchema,
  InputSavedOfferSchema,
  StageTwoFactorSeedRequestSchema,
  TwoFactorSeedSavedSchema,
} from '../../src/lib/index.ts';

/** A code card's wire (docs/input-requests.md, "Codes Ferretry makes"): keys by id and label, never a code or a seed. */
describe('a code card’s "Use code from Ferretry" buttons', () => {
  const offer = {
    id: 'GITHUB',
    label: 'GitHub',
    fills: 'totp',
    matched: true,
    signIn: 'si_0123456789abcdef',
    codes: [{ factor: 'tf_0123456789ab', label: 'Authy', checked: 'worked' }],
  } as const;

  it('should name each key by its id and the owner’s label, with what its last code came to', () => {
    should(InputSavedOfferSchema.safeParse(offer).success).be.true();
    should(InputCodeKeySchema.safeParse({ factor: 'tf_0123456789ab', label: 'Authy' }).success).be.true();
    for (const extra of [{ code: '123456' }, { seed: 'JBSWY3DPEHPK3PXP' }, { checked: 'maybe' }])
      should(InputCodeKeySchema.safeParse({ factor: 'tf_0123456789ab', label: 'Authy', ...extra }).success).be.false();
  });

  it('should carry buttons only on a matched offer with a sign-in that fills a code', () => {
    should(InputSavedOfferSchema.safeParse({ ...offer, matched: false, signIn: undefined }).success).be.false();
    should(InputSavedOfferSchema.safeParse({ ...offer, signIn: undefined }).success).be.false();
    should(InputSavedOfferSchema.safeParse({ ...offer, fills: 'password' }).success).be.false();
    should(InputSavedOfferSchema.safeParse({ ...offer, codes: [] }).success).be.false();
  });

  it('should audit the key a code came from by id, and say whether "use it now" typed it, never the code', () => {
    should(
      InputAuditDetailSchema.safeParse({ targetKind: 'browser', sensitivity: 'code', factor: 'tf_0123456789ab' })
        .success,
    ).be.true();
    should(
      InputAuditDetailSchema.safeParse({ targetKind: 'browser', sensitivity: 'code', code: '123456' }).success,
    ).be.false();
    should(Object.keys(TwoFactorSeedSavedSchema.shape)).deepEqual(['account', 'factor', 'mismatch', 'typed']);
  });

  it('should take submit on a stage only with the card it is for', () => {
    const base = { padded: 'x', totpAcknowledged: true } as const;
    should(
      StageTwoFactorSeedRequestSchema.safeParse({ ...base, request: 'a'.repeat(32), submit: true }).success,
    ).be.true();
    should(StageTwoFactorSeedRequestSchema.safeParse({ ...base, submit: true }).success).be.false();
  });
});
