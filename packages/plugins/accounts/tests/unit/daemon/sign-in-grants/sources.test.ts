import { describe, it } from 'bun:test';
import type { AccountKey, SignInId } from '@ferretry/protocol';
import should from 'should';
import { FILLS_PER_HOUR_PER_SIGN_IN, SignInGrantLedger } from '../../../src/lib/sign-in-grants/ledger.ts';
import { NO_SCRIPTED_ORIGINS, type SignInGrant } from '../../../src/lib/sign-in-grants/matcher.ts';
import type { SignInGrantSource } from '../../../src/lib/sign-in-grants/plans.ts';
import { CombinedSignInGrants } from '../../../src/lib/sign-in-grants/sources.ts';

/**
 * EVERY GRANT SOURCE AS ONE (R3c-4, invariant 22): plan lines and standing rules through one ledger, each answering for
 * its own grants only, each behind its own feature.
 */

const NOW = Date.parse('2026-11-01T12:00:00.000Z');
const SESSION = 'mvv6b4qw-49d0158d';
const SIGN_IN = 'si_0123456789abcdef01234567' as SignInId;
const KEY = `L${'a'.repeat(31)}` as AccountKey;

const grantOf = (source: 'plan' | 'rule', id: string, expiresAt: number): SignInGrant => ({
  id,
  source,
  surface: 'page',
  signIn: SIGN_IN,
  accountKey: KEY,
  fields: new Set(['password']),
  pins: { placeKeys: ['github.com'], recipeVersion: undefined, identities: undefined },
  expiresAt,
  state: 'in-force',
  remaining: 5,
});

/** A source over fixed grants, recording what is asked of it, retaining in the shared ledger as the real ones do. */
function fake(name: 'plan' | 'rule', ledger: SignInGrantLedger, grants: SignInGrant[], enabled = true) {
  const calls: string[] = [];
  const source: SignInGrantSource = {
    enabled: () => enabled,
    of: () => {
      ledger.retain(id => !id.startsWith(`${name}:`) || grants.some(each => each.id === id));
      return grants;
    },
    keyOf: async () => KEY,
    ledger,
    used: grant => void calls.push(`used ${grant.id}`),
    stopped: async (grant, because) => void calls.push(`stopped ${grant.id} ${because}`),
    verify: async grant => {
      calls.push(`verify ${grant.id}`);
      return { ok: true };
    },
    holds: grant => {
      calls.push(`holds ${grant.id}`);
      return name === 'plan';
    },
    projectOf: async () => (name === 'rule' ? 'stamped' : undefined),
    scriptedOrigins: () => (name === 'rule' ? { hosts: new Map([['github.com', NOW]]) } : NO_SCRIPTED_ORIGINS),
  };
  return { source, calls };
}

describe('CombinedSignInGrants', () => {
  it('should refuse two sources that do not share the one ledger', () => {
    const one = new SignInGrantLedger();
    const plans = fake('plan', one, []).source;
    const rules = fake('rule', new SignInGrantLedger(), []).source;
    should(() => new CombinedSignInGrants(plans, rules, one)).throw(/one ledger/u);
  });

  it('should read both sources, the soonest to expire first, and only the enabled ones', () => {
    const ledger = new SignInGrantLedger();
    const plan = grantOf('plan', 'plan:ab:0', NOW + 1_000);
    const rule = grantOf('rule', 'rule:sr_1:1', NOW + 500);
    const both = new CombinedSignInGrants(
      fake('plan', ledger, [plan]).source,
      fake('rule', ledger, [rule]).source,
      ledger,
    );
    should(both.of(SESSION).map(each => each.id)).deepEqual(['rule:sr_1:1', 'plan:ab:0']);
    should(both.enabled()).be.true();
    // `sign-in-rules.1` not advertised: no rule grant at all (invariant 32), the plan lines as before.
    const plansOnly = new CombinedSignInGrants(
      fake('plan', ledger, [plan]).source,
      fake('rule', ledger, [rule], false).source,
      ledger,
    );
    should(plansOnly.of(SESSION).map(each => each.id)).deepEqual(['plan:ab:0']);
    const none = new CombinedSignInGrants(
      fake('plan', ledger, [plan], false).source,
      fake('rule', ledger, [rule], false).source,
      ledger,
    );
    should(none.enabled()).be.false();
    should(none.of(SESSION)).deepEqual([]);
  });

  it('should send each grant’s writes and checks to the source it came from, and nowhere else', async () => {
    const ledger = new SignInGrantLedger();
    const plan = grantOf('plan', 'plan:ab:0', NOW + 1_000);
    const rule = grantOf('rule', 'rule:sr_1:1', NOW + 500);
    const plans = fake('plan', ledger, [plan]);
    const rules = fake('rule', ledger, [rule]);
    const both = new CombinedSignInGrants(plans.source, rules.source, ledger);
    both.used(rule, NOW, SESSION);
    await both.stopped(rule, 'form-changed');
    await both.verify(rule);
    const at = { sessionId: SESSION, project: undefined, roles: ['password'] as const, now: NOW };
    should(both.holds(rule, at)).be.false();
    should(both.holds(plan, at)).be.true();
    should(rules.calls).deepEqual([
      'used rule:sr_1:1',
      'stopped rule:sr_1:1 form-changed',
      'verify rule:sr_1:1',
      'holds rule:sr_1:1',
    ]);
    should(plans.calls).deepEqual(['holds plan:ab:0']);
    should(await both.projectOf(SESSION)).equal('stamped');
    should(both.scriptedOrigins().hosts.get('github.com')).equal(NOW);
  });

  it('should keep each source’s attempts and pins when the other reads its grants (no cross-wipe)', () => {
    const ledger = new SignInGrantLedger();
    const both = new CombinedSignInGrants(fake('plan', ledger, []).source, fake('rule', ledger, []).source, ledger);
    for (const id of ['plan:ab:0', 'rule:sr_1:1']) {
      const held = ledger.reserve({ id, signIn: SIGN_IN, remaining: 5 }, SESSION, ['password'], 'password', NOW);
      if (typeof held === 'string') throw new Error(held);
      ledger.spent(held, 'form');
    }
    // Neither source holds either grant now: each forgets only its own.
    const plansOnly = new CombinedSignInGrants(
      fake('plan', ledger, []).source,
      fake('rule', ledger, [grantOf('rule', 'rule:sr_1:1', NOW + 1)]).source,
      ledger,
    );
    plansOnly.of(SESSION);
    should(ledger.pinned('plan:ab:0').size).equal(0);
    should(ledger.pinned('rule:sr_1:1').size).equal(1);
    both.of(SESSION);
    should(ledger.pinned('rule:sr_1:1').size).equal(0);
  });

  it(`should refuse the ${String(FILLS_PER_HOUR_PER_SIGN_IN + 1)}th fill of one sign-in in an hour across a plan line and a rule`, () => {
    const ledger = new SignInGrantLedger();
    for (let index = 0; index < FILLS_PER_HOUR_PER_SIGN_IN; index++) {
      const id = index % 2 === 0 ? 'plan:ab:0' : 'rule:sr_1:1';
      const held = ledger.reserve(
        { id, signIn: SIGN_IN, remaining: 100 },
        `${SESSION}-${String(index)}`,
        ['password'],
        'password',
        NOW + index,
      );
      if (typeof held === 'string') throw new Error(held);
      ledger.spent(held, 'form');
    }
    should(
      ledger.reserve(
        { id: 'rule:sr_1:1', signIn: SIGN_IN, remaining: 100 },
        'fresh',
        ['password'],
        'password',
        NOW + 50,
      ),
    ).equal('rate');
  });
});
