import { describe, it } from 'bun:test';
import { padInputValue, TotpParametersSchema, twoFactorKeySummaryOf } from '@ferretry/protocol';
import should from 'should';
import { type StageCaller, TwoFactorSeedStages } from '../../../src/lib/secrets/index.ts';
import { FakeSecretCipher } from '../runtime/mounts/support.ts';

/**
 * A staged seed through its commit (secrev-1236 N1): it stays MASKED at every point the commit awaits — opening it,
 * and the store's lock and write — until the store holds its own sealed copy, and a second commit cannot start.
 */

const SEED = 'JBSWY3DPEHPK3PXP';
const OWNER: StageCaller = { key: 'admin-cli', device: false };

function world(options: { readonly deleted?: boolean } = {}) {
  const cipher = new FakeSecretCipher();
  const masked: boolean[] = [];
  let release: () => void = () => undefined;
  const lockHeld = new Promise<void>(resolve => {
    release = resolve;
  });
  let stages: TwoFactorSeedStages | undefined;
  let looking = false;
  const seen = async () => {
    looking = true;
    masked.push([...(await (stages as TwoFactorSeedStages).values()).values()].includes(SEED));
    looking = false;
  };
  // A cipher that checks the mask while the seed is being opened.
  const watchingCipher = {
    algorithm: cipher.algorithm,
    seal: cipher.seal.bind(cipher),
    openAll: async (entries: Parameters<FakeSecretCipher['openAll']>[0]) => {
      const opened = await cipher.openAll(entries);
      // Only the commit's own open of the seed (a single entry), never the masker's open of every stage.
      if (!looking && Object.keys(entries).length === 1 && Object.keys(entries)[0]?.endsWith(':seed')) await seen();
      return opened;
    },
  };
  stages = new TwoFactorSeedStages({
    accounts: {
      seedTarget: async () => ({ key: `L${'0'.repeat(24)}`, label: 'GitHub', places: [], labels: [], seeds: 0 }),
      accountsAt: async () => [],
      // The store waits for its lock, then writes: the mask must hold across both.
      addSeed: async () => {
        if (options.deleted === true) return undefined;
        await seen();
        await lockHeld;
        await seen();
        return {
          account: 'GITHUB',
          factor: twoFactorKeySummaryOf({
            id: 'tf_0123456789ab',
            kind: 'totp',
            label: 'Authenticator app',
            seal: `L${'0'.repeat(24)}_TOTP_00000000`,
            params: TotpParametersSchema.parse({}),
            addedAt: '2026-01-01T00:00:00.000Z',
            addedBy: 'owner',
          }),
        };
      },
    },
    cipher: watchingCipher,
    clock: { nowMs: () => 0 },
    anyPasskey: async () => true,
    hostName: 'kirin-box',
  });
  return { stages, masked, release: () => release() };
}

describe('a staged seed through its commit', () => {
  it('should stay masked at every await point of the commit, and refuse a second commit meanwhile', async () => {
    // Arrange
    const w = world();
    const staged = await w.stages.stage('GITHUB', { padded: padInputValue(SEED), totpAcknowledged: true }, OWNER);

    // Act — the first commit waits on the store's lock; a second one arrives meanwhile
    const first = w.stages.commit('GITHUB', staged.stage, () => true);
    await new Promise(resolve => setImmediate(resolve));
    let secondClaimed = false;
    const second = await w.stages
      .commit('GITHUB', staged.stage, () => {
        secondClaimed = true;
        return true;
      })
      .catch((error: { code?: string }) => error.code);
    const stillMasked = [...(await w.stages.values()).values()].includes(SEED);
    w.release();
    const saved = await first;

    // Assert
    should(w.masked).deepEqual([true, true, true]);
    should(stillMasked).be.true();
    should(second).equal('stage_not_found');
    should(secondClaimed).be.false();
    should(saved).match({ account: 'GITHUB', mismatch: false });
    // Once the store has it, the stage lets it go (the store's own copy masks it from then on).
    should([...(await w.stages.values()).values()]).deepEqual([]);
  });

  it('should not expire or drop a stage while it is being saved', async () => {
    // Arrange
    const w = world();
    const staged = await w.stages.stage('GITHUB', { padded: padInputValue(SEED), totpAcknowledged: true }, OWNER);

    // Act
    const first = w.stages.commit('GITHUB', staged.stage, () => true);
    await new Promise(resolve => setImmediate(resolve));
    const dropped = await w.stages.drop('GITHUB', staged.stage, OWNER).catch((error: { code?: string }) => error.code);
    const masked = [...(await w.stages.values()).values()].includes(SEED);
    w.release();
    await first;

    // Assert
    should(dropped).equal('stage_not_found');
    should(masked).be.true();
  });
});

describe('a staged seed whose account went away', () => {
  it('should save nothing, drop the stage and say the account was deleted', async () => {
    // Arrange
    const w = world({ deleted: true });
    const staged = await w.stages.stage('GITHUB', { padded: padInputValue(SEED), totpAcknowledged: true }, OWNER);

    // Act
    const refused = await w.stages
      .commit('GITHUB', staged.stage, () => true)
      .catch((error: { code?: string }) => error);

    // Assert
    should(refused).match({ status: 404, code: 'unknown_login' });
    should(await w.stages.view('GITHUB', staged.stage, OWNER)).match({ state: 'dropped' });
    should([...(await w.stages.values()).values()]).deepEqual([]);
  });
});
