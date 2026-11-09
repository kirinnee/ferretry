import { describe, it } from 'bun:test';
import type { AccountKey, SignInId } from '../../../../contract/routes/index.ts';
import should from 'should';
import { SignInGrantLedger } from '../../../../daemon/lib/sign-in-grants/ledger.ts';
import { type PlanGrantLines, PlanSignInGrants } from '../../../../daemon/lib/sign-in-grants/plans.ts';
import type { ApprovedSignInLine } from '../../../../daemon/lib/task-plans/service.ts';

const NOW = Date.parse('2026-11-01T12:00:00.000Z');
const SESSION = 'mvv6b4qw-49d0158d';
const SIGN_IN = 'si_0123456789abcdef01234567' as SignInId;
const PLAN = 'ab'.repeat(16);

const line = (over: Partial<ApprovedSignInLine> = {}): ApprovedSignInLine => ({
  planId: PLAN,
  sessionId: SESSION,
  line: 0,
  kind: 'sign-in',
  state: 'approved',
  signIn: SIGN_IN,
  fields: ['password', 'username'],
  remaining: 1,
  pins: { accountKey: `L${'a'.repeat(31)}` as AccountKey, placeKeys: ['github.com'] },
  expiresAt: NOW + 3_600_000,
  ...over,
});

function source(
  lines: ApprovedSignInLine[],
  keys: (account: string) => Promise<AccountKey | undefined> = async () => undefined,
  stopFails = false,
) {
  const calls: string[] = [];
  const plans: PlanGrantLines = {
    signInLines: session => lines.filter(each => each.sessionId === session),
    signInLineHeld: (planId, at) => lines.some(each => each.planId === planId && each.line === at),
    lineUsed: (planId, at, when) => void calls.push(`used ${planId}:${String(at)} at ${String(when)}`),
    lineStopped: async (planId, at, because) => {
      calls.push(`stopped ${planId}:${String(at)} ${because}`);
      if (stopFails) throw new Error('the plan service is gone');
    },
  };
  return Object.assign(new PlanSignInGrants(plans, keys, new SignInGrantLedger()), { calls });
}

describe('PlanSignInGrants', () => {
  it('should read each ticked line as a grant of its own session, soonest to expire first', () => {
    const grants = source([
      line({ line: 1, expiresAt: NOW + 7_200_000 }),
      line({ line: 0 }),
      line({ sessionId: 'other' }),
    ]);
    should(grants.of(SESSION).map(grant => grant.id)).deepEqual([`plan:${PLAN}:0`, `plan:${PLAN}:1`]);
    should(grants.of(SESSION)[0]).match({
      source: 'plan',
      surface: 'page',
      state: 'in-force',
      plan: { id: PLAN, line: 0 },
    });
  });

  it('should forget a gone line’s attempts and pins, and keep another source’s in a shared ledger', () => {
    const grants = source([line()]);
    for (const id of [`plan:${PLAN}:0`, `plan:${PLAN}:5`, 'rule:standing-1']) {
      const reserved = grants.ledger.reserve(
        { id, signIn: SIGN_IN, remaining: 1 },
        SESSION,
        ['password'],
        'password',
        NOW,
      );
      if (typeof reserved === 'string') throw new Error(reserved);
      grants.ledger.spent(reserved, `identity-of-${id}`);
    }
    grants.of(SESSION);
    should(grants.ledger.pinned(`plan:${PLAN}:0`).size).equal(1);
    should(grants.ledger.pinned(`plan:${PLAN}:5`).size).equal(0);
    // A standing rule's pin is not this source's to drop: dropping it would let its first-fill pin run again forever.
    should(grants.ledger.pinned('rule:standing-1').get('password')).equal('identity-of-rule:standing-1');
  });
});

describe('PlanSignInGrants: a plan line’s writes go back to its plan', () => {
  const KEY = `L${'a'.repeat(31)}` as AccountKey;

  it('should be on whenever a plan is held', () => {
    should(source([]).enabled()).be.true();
  });

  it('should find an account’s key through the plans, and none when the lookup fails', async () => {
    should(await source([], async () => KEY).keyOf('GITHUB_WORK')).equal(KEY);
    should(await source([], () => Promise.reject(new Error('locked'))).keyOf('GITHUB_WORK')).be.undefined();
  });

  it('should tell the plan a line was used, when, and ignore a grant that is not from a plan', () => {
    const grants = source([line({ line: 2 })]);
    const [grant] = grants.of(SESSION);
    if (grant === undefined) throw new Error('no grant');

    grants.used(grant, NOW, SESSION);
    grants.used({ ...grant, plan: undefined }, NOW, SESSION);

    should(grants.calls).deepEqual([`used ${PLAN}:2 at ${String(NOW)}`]);
  });

  it('should tell the plan why a line stopped, never throw if the plan cannot be told, and ignore a non-plan grant', async () => {
    const [grant] = source([line()]).of(SESSION);
    if (grant === undefined) throw new Error('no grant');
    const told = source([line()]);
    const failing = source([line()], undefined, true);

    await told.stopped(grant, 'form-changed');
    await told.stopped({ ...grant, plan: undefined }, 'form-changed');
    await failing.stopped(grant, 'form-changed');

    should(told.calls).deepEqual([`stopped ${PLAN}:0 form-changed`]);
    should(failing.calls).deepEqual([`stopped ${PLAN}:0 form-changed`]);
  });
});

describe('PlanSignInGrants: what a plan line has nothing more to say about (R3c-4)', () => {
  it('should pass the re-check and the last check, read no project and no machine-wide taint', async () => {
    const grants = source([line({})]);
    const [grant] = grants.of(SESSION);
    if (grant === undefined) throw new Error('no grant');
    should(await grants.verify(grant)).deepEqual({ ok: true });
    should(grants.holds(grant, { roles: ['password'] })).be.true();
    should(await grants.projectOf(SESSION)).be.undefined();
    should(grants.scriptedOrigins().hosts.size).equal(0);
  });
});
