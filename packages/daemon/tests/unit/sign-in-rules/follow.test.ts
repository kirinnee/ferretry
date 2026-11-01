import { describe, it } from 'bun:test';
import type { AccountId, SignInId, SignInRuleStageId } from '@ferretry/protocol';
import should from 'should';
import { SignInRuleService } from '../../../src/lib/sign-in-rules/index.ts';
import { MemoryLoginIndex } from '../runtime/mounts/support.ts';
import { CountingSealed, daemonOver } from '../secrets/accounts-fixtures.ts';
import { DEVICE, deviceOwner, evidenceFor, FakeProofs, HOST_OWNER, MemoryRuleStore, NOW } from './support.ts';

/**
 * THE ACCOUNT STORE IS FOLLOWED (r3c-plan §8, invariants 16, 17): every committed change of the real directory tells
 * the rules, and a change to a pinned fact suspends the rule in the same act; a cosmetic one does not.
 */

const IDENTITY = '0123456789abcdef';

async function world() {
  const directory = daemonOver(new MemoryLoginIndex(), new CountingSealed()).directory;
  await directory.putAccount('GITHUB' as AccountId, {
    label: 'GitHub',
    username: 'kirinnee',
    password: 'pw-UNIQUE-github',
  });
  const github = await directory.addSignIn('GITHUB' as AccountId, {
    place: { kind: 'site', domains: ['github.com'], match: [] },
    recipe: 'Open github.com and sign in',
  });
  // The owner's own taps, twice, moved on: what the observer writes for a device fill.
  for (let tap = 0; tap < 2; tap += 1)
    await directory.observeSignIn(github.id, {
      at: 'github.com',
      surface: 'page',
      identity: IDENTITY,
      masked: true,
      navigatedAway: true,
      tapped: true,
    });
  let ids = 0;
  const rules = new SignInRuleService({
    store: new MemoryRuleStore(),
    accounts: { listing: async () => await directory.keyedList() },
    proofs: new FakeProofs(),
    passkeys: { any: async () => true, of: async () => true },
    audit: { record: async () => undefined },
    clock: { now: () => NOW },
    ids: {
      ruleId: () => `sr_${(++ids).toString(16).padStart(24, '0')}`,
      stageId: () => `srs_${(++ids).toString(16).padStart(24, '0')}` as SignInRuleStageId,
    },
    warn: () => undefined,
  });
  await rules.load();
  directory.followRulesWith(async after => await rules.accountsChanged(after));
  const staged = await rules.stage(deviceOwner(), { signIn: github.id, fields: ['username', 'password'] });
  const challenge = rules.challengeOf(staged.stage, DEVICE) ?? new Uint8Array();
  await rules.commit(deviceOwner(), staged.stage, () => evidenceFor(challenge));
  const status = async () => {
    const [rule] = (await rules.list(HOST_OWNER)).rules;
    return rule?.suspended?.because ?? rule?.status;
  };
  return { directory, rules, signIn: github.id as SignInId, status };
}

describe('a pinned fact changed in the account store suspends the rule', () => {
  const cases: readonly [string, (w: Awaited<ReturnType<typeof world>>) => Promise<unknown>, string][] = [
    [
      'a recipe edit',
      async w => await w.directory.putSignIn(w.signIn, { recipe: 'Open github.com/login' }),
      'recipe-changed',
    ],
    [
      'a domains edit',
      async w =>
        await w.directory.putSignIn(w.signIn, { place: { kind: 'site', domains: ['github.com', 'gh.io'], match: [] } }),
      'place-changed',
    ],
    ['the sign-in removed', async w => await w.directory.removeSignIn(w.signIn), 'sign-in-gone'],
    ['the account removed', async w => await w.directory.removeAccount('GITHUB' as AccountId), 'sign-in-gone'],
    [
      'a rename',
      async w => await w.directory.renameAccount('GITHUB' as AccountId, 'GITHUB_WORK' as AccountId),
      'account-changed',
    ],
    [
      'a username change',
      async w => await w.directory.putAccount('GITHUB' as AccountId, { username: 'someone' }),
      'account-changed',
    ],
    [
      'a 2FA key added',
      async w => await w.directory.addFactor('GITHUB' as AccountId, { kind: 'sms', label: 'Phone' }),
      'factor-changed',
    ],
    [
      'a new form at the pinned place',
      async w =>
        await w.directory.observeSignIn(w.signIn, {
          at: 'github.com',
          surface: 'page',
          identity: 'fedcba9876543210',
          masked: true,
        }),
      'form-changed',
    ],
  ];
  for (const [name, change, because] of cases)
    it(`should suspend on ${name}`, async () => {
      const w = await world();
      should(await w.status()).equal('active');
      await change(w);
      should(await w.status()).equal(because);
    });
});

describe('a cosmetic change does not, and a suspension stays', () => {
  it('should leave the rule active after a label change, a password change and another tap', async () => {
    const w = await world();
    await w.directory.putAccount('GITHUB' as AccountId, { label: 'Work GitHub', password: 'pw-UNIQUE-new' });
    await w.directory.observeSignIn(w.signIn, {
      at: 'github.com',
      surface: 'page',
      identity: IDENTITY,
      masked: true,
      navigatedAway: true,
      tapped: true,
    });
    should(await w.status()).equal('active');
  });

  it('should stay suspended when the domains are set back', async () => {
    const w = await world();
    await w.directory.putSignIn(w.signIn, {
      place: { kind: 'site', domains: ['github.com', 'gh.io'], match: [] },
    });
    await w.directory.putSignIn(w.signIn, { place: { kind: 'site', domains: ['github.com'], match: [] } });
    should(await w.status()).equal('place-changed');
  });
});
