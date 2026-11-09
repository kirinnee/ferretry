/**
 * What staging and saving a 2FA seed refuses, and how a stage ends: a paste that was not sent padded, an account that
 * keeps the most seeds, a label already used, a store that fails while saving, and a finished stage forgotten once nobody
 * is waiting on it. A refusal holds nothing, and says what to do.
 */

import { describe, it } from 'bun:test';
import should from 'should';
import {
  addTwoFactorKeySubject,
  MAX_SEEDS_PER_ACCOUNT,
  padInputValue,
  TWO_FACTOR_ERROR_CODES,
  TWO_FACTOR_STAGE_TTL_SECONDS,
} from '../../../contract/routes/index.ts';
import { type StageCaller, TwoFactorSeedError, TwoFactorSeedStages } from './lib.ts';
import { FakeSecretCipher, SEED } from './support.ts';

const OWNER: StageCaller = { key: 'admin-cli', device: false };
const ACCOUNT_KEY = `L${'0'.repeat(24)}`;

function world(options: { seeds?: number; labels?: readonly string[]; addSeedFails?: boolean } = {}) {
  const clock = { at: 0, nowMs: () => clock.at };
  const stages = new TwoFactorSeedStages({
    accounts: {
      seedTarget: async () => ({
        key: ACCOUNT_KEY,
        label: 'GitHub',
        places: [],
        labels: options.labels ?? [],
        seeds: options.seeds ?? 0,
      }),
      accountsAt: async () => [],
      addSeed: async () => {
        if (options.addSeedFails === true) throw new Error('the sealed store is full');
        return undefined;
      },
    },
    cipher: new FakeSecretCipher(),
    clock,
    anyPasskey: async () => true,
    hostName: 'kirin-box',
  });
  return { stages, clock };
}

const stageSeed = async (w: ReturnType<typeof world>, extra: { label?: string } = {}) =>
  await w.stages.stage('GITHUB', { padded: padInputValue(SEED), totpAcknowledged: true, ...extra }, OWNER);

const refusal = async (work: Promise<unknown>) => (await work.catch((error: unknown) => error)) as TwoFactorSeedError;

describe('refusing to stage a seed', () => {
  it('should refuse a key that was not sent padded, and hold nothing', async () => {
    const w = world();

    const refused = await refusal(w.stages.stage('GITHUB', { padded: SEED, totpAcknowledged: true }, OWNER));

    should(refused).be.instanceOf(TwoFactorSeedError);
    should([refused.status, refused.code, refused.message]).eql([
      400,
      TWO_FACTOR_ERROR_CODES.notAKey,
      'the key was not sent padded; update the app',
    ]);
    should([...(await w.stages.values()).values()]).eql([]);
  });

  it('should refuse a key for an account that already keeps the most seeds, naming how to make room', async () => {
    const w = world({ seeds: MAX_SEEDS_PER_ACCOUNT });

    const refused = await refusal(stageSeed(w));

    should([refused.status, refused.code]).eql([409, 'full']);
    should(refused.message).equal(
      `GitHub already keeps ${String(MAX_SEEDS_PER_ACCOUNT)} 2FA keys Ferretry makes codes for; remove one first`,
    );
  });

  it('should refuse a label the account already uses, however it is cased or spaced', async () => {
    const w = world({ labels: ['phone app'] });

    const refused = await refusal(stageSeed(w, { label: '  Phone App ' }));

    should([refused.status, refused.code]).eql([409, 'invalid_change']);
    should(refused.message).equal('GitHub already has a 2FA key called   Phone App ; pick another label');
  });
});

describe('what a passkey for a stage is bound to', () => {
  it('should be the account’s key and the stage while it waits, and nothing for an unknown or timed-out stage', async () => {
    const w = world();
    const staged = await stageSeed(w);

    should(w.stages.boundSubjectOf(staged.stage)).equal(addTwoFactorKeySubject(ACCOUNT_KEY, staged.stage));
    should(w.stages.boundSubjectOf('st_000000000000000000000000')).be.undefined();

    w.clock.at += TWO_FACTOR_STAGE_TTL_SECONDS * 1_000;
    should(w.stages.boundSubjectOf(staged.stage)).be.undefined();
  });
});

describe('a stage’s end', () => {
  it('should drop the stage and pass the store’s failure on when saving fails, so the seed is let go', async () => {
    const w = world({ addSeedFails: true });
    const staged = await stageSeed(w);

    await should(w.stages.commit('GITHUB', staged.stage, () => true)).be.rejectedWith('the sealed store is full');

    should((await w.stages.view('GITHUB', staged.stage, OWNER)).state).equal('dropped');
    should([...(await w.stages.values()).values()]).eql([]);
  });

  it('should answer a finished stage for a while, and then forget it', async () => {
    const w = world();
    const staged = await stageSeed(w);
    await w.stages.drop('GITHUB', staged.stage, OWNER);
    should((await w.stages.view('GITHUB', staged.stage, OWNER)).state).equal('dropped');

    w.clock.at += 2 * TWO_FACTOR_STAGE_TTL_SECONDS * 1_000;

    const gone = await refusal(w.stages.view('GITHUB', staged.stage, OWNER));
    should([gone.status, gone.code]).eql([404, TWO_FACTOR_ERROR_CODES.stageGone]);
  });
});
