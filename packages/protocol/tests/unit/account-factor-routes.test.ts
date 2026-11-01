import { describe, it } from 'bun:test';
import should from 'should';
import {
  ADD_TWO_FACTOR_KEY_WHERE,
  AddTwoFactorKeyRequestSchema,
  AgendaItemSchema,
  PASSKEY_CHALLENGE_TTL_SECONDS,
  PatchTwoFactorKeyRequestSchema,
  StageTwoFactorSeedRequestSchema,
  TWO_FACTOR_STAGE_TTL_SECONDS,
  TwoFactorSeedStagedSchema,
  TwoFactorSeedStageViewSchema,
} from '../../src/lib/index.ts';

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

  it('should let a staged seed wait exactly one passkey challenge', () => {
    should(TWO_FACTOR_STAGE_TTL_SECONDS).equal(PASSKEY_CHALLENGE_TTL_SECONDS);
  });

  it('should say where a seed is saved now', () => {
    should(ADD_TWO_FACTOR_KEY_WHERE).containEql('fy account factor add');
    should(ADD_TWO_FACTOR_KEY_WHERE).containEql('Settings › Accounts');
  });

  it('should keep a staged seed card on an agenda item, and an older app drop it as a plain card', () => {
    const item = {
      id: 'A7',
      source: 'question',
      sourceRef: `st_${'a'.repeat(24)}`,
      subject: 'Save automatic codes to GitHub · kirinnee?',
      why: 'Asked by `fy` on kirin-box at 14:02 UTC.',
      howToResolve: 'Allow on this card in the Ferretry app.',
      waitingSince: '2026-10-31T12:00:00Z',
      kind: 'permission',
      raisedBy: 'daemon',
      raisedBySession: null,
      raisedByName: null,
      twoFactorSeed: { stage: `st_${'a'.repeat(24)}`, account: 'GITHUB' },
    };
    const parsed = AgendaItemSchema.safeParse(item);
    should(parsed.success).be.true();
    should(parsed.data?.twoFactorSeed).eql({ stage: `st_${'a'.repeat(24)}`, account: 'GITHUB' });
    should(
      AgendaItemSchema.safeParse({ ...item, twoFactorSeed: { stage: 'st_x', account: 'GITHUB' } }).success,
    ).be.false();
  });
});
