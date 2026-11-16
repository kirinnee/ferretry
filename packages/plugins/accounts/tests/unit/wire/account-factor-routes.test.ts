import { describe, it } from 'bun:test';
import should from 'should';
import {
  ADD_TWO_FACTOR_KEY_WHERE,
  AddTwoFactorKeyRequestSchema,
  PASSKEY_CHALLENGE_TTL_SECONDS,
  PatchTwoFactorKeyRequestSchema,
  StageTwoFactorSeedRequestSchema,
  TWO_FACTOR_STAGE_TTL_SECONDS,
  TwoFactorSeedStagedSchema,
  TwoFactorKeySummarySchema,
  TwoFactorSeedStageViewSchema,
} from '../../../contract/routes/index.ts';

/** The 2FA key routes' wire (docs/secrets.md, "2FA keys"): no shape a client sends or reads can carry a seed. */
describe('the 2FA key route shapes', () => {
  it('should take no seed, seal or code parameters when adding a key, of any kind', () => {
    for (const extra of [{ seed: 'JBSWY3DPEHPK3PXP' }, { seal: 'x' }, { params: {} }, { secret: 'x' }, { value: 'x' }])
      for (const kind of ['totp', 'sms', 'email', 'push', 'security-key'])
        should(AddTwoFactorKeyRequestSchema.safeParse({ kind, label: 'x', ...extra }).success).be.false();
    should(AddTwoFactorKeyRequestSchema.safeParse({ kind: 'sms', label: 'Phone', endsWith: '42' }).success).be.true();
    should(
      AddTwoFactorKeyRequestSchema.safeParse({ kind: 'sms', label: 'Phone', endsWith: '0712345678' }).success,
    ).be.false();
  });

  it('should never let a relabel change a kind or carry a value', () => {
    for (const extra of [{ kind: 'totp' }, { seed: 'x' }, { seal: 'x' }, { params: {} }])
      should(PatchTwoFactorKeyRequestSchema.safeParse({ label: 'x', ...extra }).success).be.false();
  });

  it('should stage only with the warning ticked, and answer what was read, never a seed', () => {
    should(StageTwoFactorSeedRequestSchema.safeParse({ padded: 'x' }).success).be.false();
    should(StageTwoFactorSeedRequestSchema.safeParse({ padded: 'x', totpAcknowledged: false }).success).be.false();
    should(StageTwoFactorSeedRequestSchema.safeParse({ padded: 'x', totpAcknowledged: true }).success).be.true();
    const keys = (shape: { shape: Record<string, unknown> }) => Object.keys(shape.shape);
    for (const key of [
      ...keys(TwoFactorSeedStagedSchema),
      ...keys(TwoFactorSeedStagedSchema.shape.parsed),
      ...keys(TwoFactorSeedStageViewSchema),
    ])
      should(key).not.match(/seed|secret|value|code|seal|padded|uri/iu);
  });

  it('I175 should never let a seed leave the use boundary: no answer holds one, and staging needs the warning ticked', () => {
    // Off by default and explicit: the stage request is refused unless the warning is ticked, and the tick is `true`.
    for (const tick of [undefined, false, 'true', 1])
      should(StageTwoFactorSeedRequestSchema.safeParse({ padded: 'x', totpAcknowledged: tick }).success).be.false();
    should(StageTwoFactorSeedRequestSchema.safeParse({ padded: 'x', totpAcknowledged: true }).success).be.true();
    // What the owner reads of a key, and what any answer about a stage says, names no seed, seal or code.
    const summary = TwoFactorKeySummarySchema.parse({
      id: 'tf_0123456789ab',
      kind: 'totp',
      label: 'Authenticator app',
      addedAt: '2026-01-01T00:00:00.000Z',
      addedBy: 'owner',
      automatic: true,
      params: { algorithm: 'SHA1', digits: 6, period: 30 },
    });
    for (const key of Object.keys(summary)) should(key).not.match(/seed|secret|seal|code|padded|uri/iu);
    should(TwoFactorKeySummarySchema.safeParse({ ...summary, seal: 'L0_TOTP_00000000' }).success).be.false();
    should(TwoFactorKeySummarySchema.safeParse({ ...summary, seed: 'JBSWY3DPEHPK3PXP' }).success).be.false();
    for (const key of Object.keys(TwoFactorSeedStageViewSchema.shape))
      should(key).not.match(/seed|secret|value|code|seal|padded|uri/iu);
  });

  it('should let a staged seed wait exactly one passkey challenge', () => {
    should(TWO_FACTOR_STAGE_TTL_SECONDS).equal(PASSKEY_CHALLENGE_TTL_SECONDS);
  });

  it('should say where a seed is saved now', () => {
    should(ADD_TWO_FACTOR_KEY_WHERE).containEql('fy account factor add');
    should(ADD_TWO_FACTOR_KEY_WHERE).containEql('Settings › Accounts');
  });
});
