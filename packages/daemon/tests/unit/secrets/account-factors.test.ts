import { describe, it } from 'bun:test';
import { TotpParametersSchema } from '@ferretry/protocol';
import should from 'should';
import { maskRoleOf, totpCode } from '../../../src/lib/secrets/index.ts';
import { MemoryLoginIndex } from '../runtime/mounts/support.ts';
import { CountingSealed, daemonOver } from './accounts-fixtures.ts';

/**
 * An account's 2FA keys in the store (r2-plan §1.2, §4.3; invariants 1, 14, 15): a seed is saved under a fresh sealed
 * name of ITS account, a code is made from the key named, every seed is masked, and a removed key's seed is swept.
 */

const ONE = 'JBSWY3DPEHPK3PXP';
const TWO = 'GEZDGNBVGY3TQOJQ';
const PARAMS = TotpParametersSchema.parse({});

async function world() {
  const index = new MemoryLoginIndex();
  const sealed = new CountingSealed();
  const daemon = daemonOver(index, sealed);
  await daemon.directory.putAccount('GITHUB', { label: 'GitHub', username: 'kirinnee', password: 'pw-UNIQUE-1' });
  await daemon.directory.putAccount('GOOGLE', { label: 'Google' });
  const key = (await daemon.directory.seedTarget('GITHUB')).key;
  const first = await daemon.directory.addSeed(key, ONE, { params: PARAMS });
  const second = await daemon.directory.addSeed(key, TWO, { params: PARAMS, label: 'Backup' });
  return { index, sealed, ...daemon, key, first: first?.factor.id ?? '', second: second?.factor.id ?? '' };
}

describe('2FA keys in the account store', () => {
  it('should seal each seed under a fresh TOTP name of its own account, labelled, with no value in the index', async () => {
    // Arrange + Act
    const w = await world();

    // Assert
    const factors = w.index.accounts.accounts.GITHUB?.factors ?? [];
    should(factors.map(factor => factor.label)).deepEqual(['Authenticator app', 'Backup']);
    for (const factor of factors)
      should(factor.kind === 'totp' ? factor.seal : '').match(new RegExp(`^${w.key}_TOTP_[0-9A-F]{8}$`, 'u'));
    should(JSON.stringify(w.index.document)).not.containEql(ONE);
    should(JSON.stringify(w.index.document)).not.containEql(TWO);
  });

  it('should make the code from the key named, and refuse a key that is not this account’s or holds no seed', async () => {
    // Arrange
    const w = await world();
    const sms = await w.directory.addFactor('GITHUB', { kind: 'sms', label: 'Phone' });

    // Act + Assert
    should(await w.vault.fill('GITHUB', 'totp', 59_000, { factor: w.second })).equal(totpCode(TWO, PARAMS, 59_000));
    should(await w.vault.fill('GITHUB', 'totp', 59_000, { factor: w.first })).equal(totpCode(ONE, PARAMS, 59_000));
    for (const factor of [sms.id, 'tf_000000000000'])
      should(
        await w.vault.fill('GITHUB', 'totp', 59_000, { factor }).catch((error: { refusal?: string }) => error.refusal),
      ).equal('no_such_field');
    should(
      await w.vault
        .fill('GOOGLE', 'totp', 59_000, { factor: w.first })
        .catch((error: { refusal?: string }) => error.refusal),
    ).equal('no_such_field');
  });

  it('should mask every seed an account keeps, by its key', async () => {
    // Arrange
    const w = await world();

    // Act
    const values = await w.vault.values();

    // Assert
    should(values.get('login:GITHUB:totp')).equal(ONE);
    should(values.get(`login:GITHUB:totp:${w.second}`)).equal(TWO);
    should(values.get('login:GITHUB:password')).equal('pw-UNIQUE-1');
    should([...values.keys()].some(name => name.startsWith('login:unnamed:'))).be.false();
  });

  it('should sweep a removed key’s seed, and keep the other', async () => {
    // Arrange
    const w = await world();

    // Act
    should(await w.directory.removeFactor('GITHUB', w.first)).be.true();
    should(await w.directory.removeFactor('GITHUB', w.first)).be.false();

    // Assert
    const sealedText = JSON.stringify((await w.sealed.read())?.entries ?? {});
    const values = [...(await w.vault.values()).values()];
    should(values).not.containEql(ONE);
    should(values).containEql(TWO);
    should(Object.keys((await w.sealed.read())?.entries ?? {}).filter(name => name.includes('_TOTP_'))).have.length(1);
    should(sealedText).not.containEql([...ONE].reverse().join(''));
  });

  it('should refuse a fifth seed and a label the account already has', async () => {
    // Arrange
    const w = await world();
    await w.directory.addSeed(w.key, ONE, { params: PARAMS, label: 'Three' });
    await w.directory.addSeed(w.key, ONE, { params: PARAMS, label: 'Four' });

    // Act
    const fifth = await w.directory.addSeed(w.key, ONE, { params: PARAMS, label: 'Five' }).catch(error => error);
    const clash = await w.directory.addFactor('GITHUB', { kind: 'push', label: 'backup' }).catch(error => error);

    // Assert
    should(fifth).match({ refusal: 'invalid_change' });
    should(clash).match({ refusal: 'invalid_change' });
    should(w.index.accounts.accounts.GITHUB?.factors).have.length(4);
  });
});

describe('the mask name of a sealed value', () => {
  it('should give the password, the first seed, other seeds and an unknown name each a key of their own', () => {
    // Arrange — the "stub": a name that is neither the password nor a seed, which sealedNamesOf never yields today
    const account = {
      seals: { password: 'LPW' },
      factors: [
        { id: 'tf_aaaaaaaaaaaa', kind: 'totp', label: 'A', seal: 'LONE', addedAt: 't', addedBy: 'owner' },
        { id: 'tf_bbbbbbbbbbbb', kind: 'totp', label: 'B', seal: 'LTWO', addedAt: 't', addedBy: 'owner' },
        { id: 'tf_cccccccccccc', kind: 'sms', label: 'C', addedAt: 't', addedBy: 'owner' },
      ],
    } as never;

    // Act
    const roles = ['LPW', 'LONE', 'LTWO', 'LSTRAY', 'LOTHER'].map(name => maskRoleOf(account, name));

    // Assert — all distinct, so no value shares a key with another and goes unmasked
    should(roles).deepEqual(['password', 'totp', 'totp:tf_bbbbbbbbbbbb', 'totp:LSTRAY', 'totp:LOTHER']);
    should(new Set(roles).size).equal(roles.length);
  });
});
