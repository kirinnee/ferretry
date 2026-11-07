import { describe, it } from 'bun:test';
import type { AccountKey, SignInId } from '@ferretry/protocol';
import should from 'should';
import { SignInGrantLedger } from '../../../src/lib/sign-in-grants/ledger.ts';
import { type PlanGrantLines, PlanSignInGrants } from '../../../src/lib/sign-in-grants/plans.ts';
import type { ApprovedSignInLine } from '../../../src/lib/task-plans/service.ts';

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

function source(lines: ApprovedSignInLine[]) {
  const plans: PlanGrantLines = {
    signInLines: session => lines.filter(each => each.sessionId === session),
    signInLineHeld: (planId, at) => lines.some(each => each.planId === planId && each.line === at),
    lineUsed: () => undefined,
    lineStopped: async () => undefined,
  };
  return new PlanSignInGrants(
    plans,
    async () => undefined,
    () => true,
    new SignInGrantLedger(),
  );
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
