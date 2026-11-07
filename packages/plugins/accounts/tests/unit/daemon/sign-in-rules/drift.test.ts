import { describe, it } from 'bun:test';
import { factorFingerprint, type SignInRuleBody } from '@ferretry/protocol';
import should from 'should';
import { type RuleListing, ruleDrift, samePins, snapshotPins } from '../../../src/lib/sign-in-rules/index.ts';
import { account, DEVICE, GITHUB, KEY, listing, OTHER_KEY, signIn, T, tappedFact, totpKey } from './support.ts';

/** Pinned facts and their drift, pure (r3c-plan §8, invariant 16). */

const KEYS = [totpKey('tf_000000000001', T, true)];

const base = (): RuleListing => {
  const fixture = listing();
  return {
    ...fixture,
    accounts: fixture.accounts.map(each => (each.id === 'GITHUB_WORK' ? account({ factors: KEYS }) : each)),
    signIns: fixture.signIns.map(each => (each.id === GITHUB ? signIn({ recipeVersion: 3 } as never) : each)),
  };
};

function bodyOver(world: RuleListing): SignInRuleBody {
  const snap = snapshotPins(world, GITHUB, false);
  if (!snap.ok) throw new Error(`no pins: ${snap.because}`);
  return {
    v: 1,
    id: `sr_${'1'.repeat(24)}`,
    revision: 1,
    signIn: GITHUB,
    surface: 'page',
    fields: ['username', 'password'],
    pins: snap.pins,
    scope: { kind: 'any' },
    createdAt: T,
    expiresAt: '2026-10-31T00:00:00.000Z',
    approvedBy: { deviceId: DEVICE },
  };
}

const withSignIn = (world: RuleListing, change: Record<string, unknown>): RuleListing => ({
  ...world,
  signIns: world.signIns.map(each => (each.id === GITHUB ? ({ ...each, ...change } as never) : each)),
});
const withAccount = (world: RuleListing, change: Record<string, unknown>): RuleListing => ({
  ...world,
  accounts: world.accounts.map(each => (each.id === 'GITHUB_WORK' ? ({ ...each, ...change } as never) : each)),
});

describe('the pins a rule is approved against', () => {
  it('should snapshot the key, handle, username, domains, recipe, tapped identities and the 2FA fingerprint', () => {
    const snap = snapshotPins(base(), GITHUB, false);
    should(snap.ok).be.true();
    if (!snap.ok) return;
    should(snap.pins).eql({
      accountKey: KEY,
      account: 'GITHUB_WORK',
      username: 'kirin-UNIQUE-username',
      placeKeys: ['github.com'],
      recipeVersion: 3,
      identities: ['0123456789abcdef'],
      factors: factorFingerprint(KEYS),
    });
  });

  it('should compare pins as sets', () => {
    const snap = snapshotPins(base(), GITHUB, false);
    if (!snap.ok) throw new Error('no pins');
    should(samePins(snap.pins, { ...snap.pins, placeKeys: [...snap.pins.placeKeys] })).be.true();
    should(samePins(snap.pins, { ...snap.pins, placeKeys: ['github.com', 'gh.io'] })).be.false();
    should(samePins(snap.pins, { ...snap.pins, recipeVersion: 4 })).be.false();
  });
});

describe('drift suspends, with the reason (invariant 16)', () => {
  const cases: readonly [string, (world: RuleListing) => RuleListing, string][] = [
    [
      'the sign-in removed',
      world => ({ ...world, signIns: world.signIns.filter(each => each.id !== GITHUB) }),
      'sign-in-gone',
    ],
    [
      'the account deleted',
      world => ({ ...world, accounts: world.accounts.filter(each => each.id !== 'GITHUB_WORK') }),
      'sign-in-gone',
    ],
    [
      'a rename (same key, new handle)',
      world => ({
        ...withAccount(withSignIn(world, { account: 'GITHUB_RENAMED' }), { id: 'GITHUB_RENAMED' }),
        keys: new Map([...world.keys, ['GITHUB_RENAMED', KEY]]),
      }),
      'account-changed',
    ],
    [
      'a merge (the handle now another account)',
      world => ({ ...world, keys: new Map([...world.keys, ['GITHUB_WORK', OTHER_KEY]]) }),
      'account-changed',
    ],
    ['a username change', world => withAccount(world, { username: 'someone-else' }), 'account-changed'],
    ['another method', world => withSignIn(world, { method: { kind: 'google' } }), 'account-changed'],
    [
      'a provider it now goes via',
      world =>
        withSignIn(world, {
          method: { kind: 'google', via: 'GOOGLE' },
          via: { account: { id: 'GOOGLE', label: 'Google' } },
        }),
      'account-changed',
    ],
    [
      'a domains edit',
      world => withSignIn(world, { place: { kind: 'site', domains: ['github.com', 'gh.io'], match: [] } }),
      'place-changed',
    ],
    ['a recipe bump', world => withSignIn(world, { recipeVersion: 4 }), 'recipe-changed'],
    ['a recipe cleared', world => withSignIn(world, { recipeVersion: undefined }), 'recipe-changed'],
    [
      'a 2FA key added',
      world => withAccount(world, { factors: [...KEYS, totpKey('tf_000000000002', T)] }),
      'factor-changed',
    ],
    ['a 2FA key removed', world => withAccount(world, { factors: [] }), 'factor-changed'],
    [
      'a 2FA key stripped of its seed',
      world => withAccount(world, { factors: [{ ...KEYS[0], automatic: false, params: undefined }] }),
      'factor-changed',
    ],
    [
      'an identity reset at a pinned place',
      world => withSignIn(world, { observed: [tappedFact('github.com', 1, 'fedcba9876543210')] }),
      'form-changed',
    ],
  ];
  for (const [name, change, because] of cases)
    it(`should suspend on ${name}`, () => {
      const world = base();
      should(ruleDrift(bodyOver(world), change(world))).equal(because);
    });
});

describe('what is not drift (invariants 15, 16)', () => {
  const cases: readonly [string, (world: RuleListing) => RuleListing][] = [
    ['a label change', world => withAccount(world, { label: 'Work GitHub' })],
    [
      'a 2FA key checked by use (verified flipped)',
      world => withAccount(world, { factors: [totpKey('tf_000000000001', T, false)] }),
    ],
    ['a 2FA key renamed', world => withAccount(world, { factors: [{ ...KEYS[0], label: 'Phone' }] })],
    ['a pending proposal', world => withSignIn(world, { proposals: [{ id: 'rp_0000000000000001' }] })],
    [
      'another tap counted at the pinned identity',
      world => withSignIn(world, { observed: [tappedFact('github.com', 5)] }),
    ],
    [
      'a fact at another place',
      world => withSignIn(world, { observed: [tappedFact('github.com'), tappedFact('accounts.google.com')] }),
    ],
    ['a password value change (nothing in the listing moves)', world => ({ ...world })],
  ];
  for (const [name, change] of cases)
    it(`should not suspend on ${name}`, () => {
      const world = base();
      should(ruleDrift(bodyOver(world), change(world))).be.undefined();
    });
});
