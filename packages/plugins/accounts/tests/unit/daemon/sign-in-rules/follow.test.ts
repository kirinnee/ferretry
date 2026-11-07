import { describe, it } from 'bun:test';
import { type AccountId, type SignInId, type SignInRuleStageId, TotpParametersSchema } from '@ferretry/protocol';
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

type Directory = ReturnType<typeof daemonOver>['directory'];

/** The world, with `before` run on the directory before the rule is approved (keys, auto-apply, a second account). */
async function world(before?: (directory: Directory, signIn: SignInId) => Promise<unknown>) {
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
  await before?.(directory, github.id as SignInId);
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

const GITHUB = 'GITHUB' as AccountId;
const PROPOSAL = (id: string) => ({
  id,
  recipe: 'Open github.com/login, then sign in',
  base: 'Open github.com and sign in',
  why: 'the page moved',
  sessionId: 'mvv6b4qw-49d0158d',
  proposedAt: '2026-10-31T09:00:00.000Z',
});

describe('the rest of the account store, followed (secrev-1274b L4)', () => {
  it('should suspend on a merge that moves the sign-in to another account', async () => {
    const w = await world(async directory => await directory.putAccount('OTHER' as AccountId, { label: 'Other' }));
    await w.directory.merge('OTHER' as AccountId, GITHUB);
    should(await w.status()).equal('account-changed');
  });

  it('should not suspend on keeping two accounts apart', async () => {
    const w = await world(async directory => await directory.putAccount('OTHER' as AccountId, { label: 'Other' }));
    await w.directory.apart(GITHUB, 'OTHER' as AccountId);
    should(await w.status()).equal('active');
  });

  it('should not suspend on a 2FA key relabelled or its plain facts edited, and suspend on its removal', async () => {
    const w = await world(async directory => await directory.addFactor(GITHUB, { kind: 'sms', label: 'Phone' }));
    const [key] = (await w.directory.list()).accounts[0]?.factors ?? [];
    await w.directory.patchFactor(GITHUB, key?.id as never, { label: 'Old phone', endsWith: '42' });
    should(await w.status()).equal('active');
    await w.directory.removeFactor(GITHUB, key?.id as never);
    should(await w.status()).equal('factor-changed');
  });

  it('should not suspend on a code checked by use, and suspend on a seed added', async () => {
    const params = TotpParametersSchema.parse({});
    const w = await world(async directory => {
      const key = (await directory.seedTarget(GITHUB)).key;
      await directory.addSeed(key, 'JBSWY3DPEHPK3PXP', { params });
    });
    const [seeded] = (await w.directory.list()).accounts[0]?.factors ?? [];
    await w.directory.checkedByUse(GITHUB, seeded?.id as never, true);
    await w.directory.checkedByUse(GITHUB, seeded?.id as never, false);
    should(await w.status()).equal('active');
    await w.directory.addSeed((await w.directory.seedTarget(GITHUB)).key, 'GEZDGNBVGY3TQOJQ', { params });
    should(await w.status()).equal('factor-changed');
  });

  it('should not suspend on a pending proposal, and suspend when the owner approves it', async () => {
    const w = await world();
    await w.directory.proposeSignIn(w.signIn, PROPOSAL('rp_0000000000000001'));
    should(await w.status()).equal('active');
    await w.directory.decideSignIn(w.signIn, 'rp_0000000000000001', 'approve');
    should(await w.status()).equal('recipe-changed');
  });

  it('should suspend when a ferret’s proposal is auto-applied', async () => {
    const w = await world(async (directory, signIn) => await directory.putSignIn(signIn, { autoApplyRecipe: true }));
    const { applied } = await w.directory.proposeSignIn(w.signIn, PROPOSAL('rp_0000000000000002'));
    should(applied).be.true();
    should(await w.status()).equal('recipe-changed');
  });

  it('should suspend when the sign-in stops typing a password of its own, and stay suspended when it goes back', async () => {
    const w = await world();
    await w.directory.putSignIn(w.signIn, { method: { kind: 'google' } });
    should(await w.status()).equal('account-changed');
    await w.directory.putSignIn(w.signIn, { method: { kind: 'password' } });
    should(await w.status()).equal('account-changed');
  });
});
