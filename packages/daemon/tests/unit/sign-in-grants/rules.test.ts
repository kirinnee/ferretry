import { describe, it } from 'bun:test';
import { type AccountKey, type SignInRuleId, UNFILED_PROJECT_ID } from '@ferretry/protocol';
import should from 'should';
import { SignInGrantLedger } from '../../../src/lib/sign-in-grants/ledger.ts';
import { RuleSignInGrants, stampedProjectOf } from '../../../src/lib/sign-in-grants/rules.ts';
import {
  actions,
  approved,
  deviceOwner,
  GITHUB,
  KEY,
  NOW,
  totpKey,
  type World,
  world,
} from '../sign-in-rules/support.ts';

/**
 * STANDING RULES AS GRANTS (R3c-4) over the REAL rule service (fake registry and store): what a fill reads of a rule,
 * the synchronous last check before typing, the offline re-check before the second match, the machine-wide script
 * taint, and uses counted the moment they are spent.
 */

const SESSION = 'mvv6b4qw-49d0158d';
const OTHER = 'mvv6b4qw-49d0158e';
const PROJECT = '0b4cbd4a-6f1c-4d3c-9d55-2a3f5f1c9e01';
const LOGIN = { sessionId: SESSION, project: undefined, roles: ['username', 'password'] as const, now: NOW };

function grants(w: World, options: { advertised?: boolean; project?: string } = {}) {
  const ledger = new SignInGrantLedger();
  const source = new RuleSignInGrants({
    rules: w.service,
    ledger,
    keys: async () => KEY as AccountKey,
    advertised: () => options.advertised ?? true,
    stampedProject: async () => options.project,
    clock: { now: () => w.clock.now },
  });
  return { source, ledger };
}

/** Lets the rule service's queued writes land. */
const settled = async (): Promise<void> => await new Promise(resolve => setTimeout(resolve, 5));

describe('RuleSignInGrants: what a fill reads of a rule', () => {
  it('should read a rule as a grant: its id and revision, scope, pins, account pins and no cap', async () => {
    const w = await world();
    const { view } = await approved(w);
    const { source } = grants(w);
    const [grant] = source.of(SESSION);
    should(grant).match({
      id: `rule:${view.id}:1`,
      source: 'rule',
      rule: { id: view.id, revision: 1 },
      surface: 'page',
      signIn: GITHUB,
      accountKey: KEY,
      scope: { kind: 'any' },
      accountPins: { id: 'GITHUB_WORK', username: 'kirin-UNIQUE-username' },
      state: 'in-force',
      remaining: Number.POSITIVE_INFINITY,
    });
    should([...(grant?.fields ?? [])].sort()).deepEqual(['password', 'username']);
    should(grant?.pins.identities).deepEqual(['0123456789abcdef']);
    // Any session reads the same rule: the matcher's scope check decides (and says `out-of-scope` to the owner).
    should(source.of(OTHER).map(each => each.id)).deepEqual([grant?.id]);
  });

  it('should read a suspended rule as stopped, an expired one as ended, and narrowing as what is in force', async () => {
    const w = await world();
    const { view } = await approved(w, { signIn: GITHUB, fields: ['username', 'password'], uses: 3 });
    const { source } = grants(w);
    await w.service.narrow(deviceOwner(), view.id, { uses: 1 });
    should(source.of(SESSION)[0]).match({ remaining: 1, state: 'in-force' });
    await w.service.scriptedOn('github.com');
    should(source.of(SESSION)[0]?.state).equal('stopped');
    const late = await world();
    await approved(late);
    late.clock.now = NOW + 31 * 86_400_000;
    should(grants(late).source.of(SESSION)[0]?.expiresAt).be.belowOrEqual(late.clock.now);
  });

  it('should offer no rule at all while `sign-in-rules.1` is not advertised (invariant 32, at the composite)', async () => {
    const w = await world();
    await approved(w);
    should(grants(w, { advertised: false }).source.enabled()).be.false();
  });

  it('should forget a rule’s attempts when it is approved again (a resumed rule starts fresh), and never a plan’s', async () => {
    const w = await world();
    await approved(w);
    const { source, ledger } = grants(w);
    const [grant] = source.of(SESSION);
    const reserve = (id: string) =>
      ledger.reserve({ id, signIn: GITHUB, remaining: 5 }, SESSION, ['password'], 'password', NOW);
    for (const id of [grant?.id as string, 'plan:ab:0']) {
      const held = reserve(id);
      if (typeof held === 'string') throw new Error(held);
      ledger.spent(held, 'form');
    }
    source.of(SESSION);
    should(ledger.pinned(grant?.id as string).size).equal(1);
    await w.service.revoke(deviceOwner(), grant?.rule?.id as SignInRuleId);
    source.of(SESSION);
    should(ledger.pinned(grant?.id as string).size).equal(0);
    should(ledger.pinned('plan:ab:0').size).equal(1);
  });
});

describe('RuleSignInGrants: the synchronous last check before typing', () => {
  it('should hold a verified rule in force that covers the roles, the session and no tainted place', async () => {
    const w = await world();
    await approved(w);
    const { source } = grants(w);
    const [grant] = source.of(SESSION);
    if (grant === undefined) throw new Error('no grant');
    should(source.holds(grant, LOGIN)).be.true();
    should(source.holds(grant, { ...LOGIN, sessionId: OTHER })).be.true();
  });

  it('should refuse a rule revoked, suspended or approved again since the grant was read', async () => {
    for (const change of ['revoke', 'suspend'] as const) {
      const w = await world();
      const { view } = await approved(w);
      const { source } = grants(w);
      const [grant] = source.of(SESSION);
      if (grant === undefined) throw new Error('no grant');
      if (change === 'revoke') await w.service.revoke(deviceOwner(), view.id);
      else await w.service.suspend(view.id, 'did-not-move-on');
      should(source.holds(grant, LOGIN)).be.false();
    }
  });

  it('should refuse a rule whose proof is no longer verified (a passkey removed), with no I/O at the check', async () => {
    const w = await world();
    await approved(w);
    const { source } = grants(w);
    const [grant] = source.of(SESSION);
    if (grant === undefined) throw new Error('no grant');
    w.proofs.held.clear();
    await w.service.passkeysChanged({ cause: 'passkey-removed', deviceId: 'whoever' } as never);
    should(source.holds(grant, LOGIN)).be.false();
  });

  it('should refuse a rule the service no longer calls verified though nothing suspended it (a check still owed)', async () => {
    const w = await world();
    await approved(w);
    const { source } = grants(w);
    const [grant] = source.of(SESSION);
    if (grant === undefined) throw new Error('no grant');
    // The registry can't be read when a passkey change asks for every proof again: no rule is suspended for it, and
    // none is verified until a sweep settles it.
    w.proofs.broken = true;
    await w.service.passkeysChanged({ cause: 'passkey-removed', deviceId: 'whoever' } as never);
    should(w.store.document?.rules[0]?.suspended).be.undefined();
    should(w.service.verified(grant.rule?.id as SignInRuleId, 1)).be.false();
    should(source.holds(grant, LOGIN)).be.false();
    w.proofs.broken = false;
    await w.service.sweepRules();
    should(source.holds(grant, LOGIN)).be.true();
  });

  it('should refuse a role the owner narrowed away (dropping the code mid-attempt stops the code)', async () => {
    const w = await world();
    w.state.listing = {
      ...w.state.listing,
      accounts: w.state.listing.accounts.map(account =>
        account.id === 'GITHUB_WORK'
          ? {
              ...account,
              fields: { password: true, totp: true },
              factors: [totpKey('tf_000000000002', '2026-09-01T00:00:00.000Z')],
            }
          : account,
      ),
    } as never;
    const { view } = await approved(w, {
      signIn: GITHUB,
      fields: ['username', 'password'],
      totp: true,
      totpAcknowledged: true,
    });
    const { source } = grants(w);
    const [grant] = source.of(SESSION);
    if (grant === undefined) throw new Error('no grant');
    const code = { ...LOGIN, roles: ['totp'] as const };
    should(source.holds(grant, code)).be.true();
    await w.service.narrow(deviceOwner(), view.id, { dropTotp: true });
    should(source.holds(grant, code)).be.false();
    should(source.holds(grant, LOGIN)).be.true();
  });

  it('should hold a session-scoped rule only for that session, and a project rule only for its stamped project', async () => {
    const w = await world();
    await approved(w, {
      signIn: GITHUB,
      fields: ['username', 'password'],
      scope: { kind: 'session', session: SESSION },
    });
    const { source } = grants(w);
    const [grant] = source.of(SESSION);
    if (grant === undefined) throw new Error('no grant');
    should(source.holds(grant, LOGIN)).be.true();
    should(source.holds(grant, { ...LOGIN, sessionId: `${SESSION}-child` })).be.false();
    const p = await world();
    await approved(p, {
      signIn: GITHUB,
      fields: ['username', 'password'],
      scope: { kind: 'project', project: PROJECT },
    });
    const scoped = grants(p).source;
    const [projectGrant] = scoped.of(SESSION);
    if (projectGrant === undefined) throw new Error('no grant');
    should(scoped.holds(projectGrant, { ...LOGIN, project: PROJECT })).be.true();
    should(scoped.holds(projectGrant, LOGIN)).be.false();
  });

  it('should refuse the moment a page script runs on its place, before the suspension is even written', async () => {
    const w = await world();
    await approved(w);
    const { source } = grants(w);
    const [grant] = source.of(SESSION);
    if (grant === undefined) throw new Error('no grant');
    let release: () => void = () => undefined;
    w.store.beforeWrite = async () => await new Promise<void>(resolve => (release = resolve));
    source.scriptedOn('github.com');
    // Synchronously, in the same tick: the RAM taint alone already refuses.
    should(source.holds(grant, LOGIN)).be.false();
    release();
    w.store.beforeWrite = undefined;
    await settled();
    should(actions(w)).containEql('sign-in-rule-suspended');
    should(w.store.document?.rules[0]?.suspended?.because).equal('scripted-origin');
  });

  it('should refuse EVERY rule when a script ran where its origin could not be read, and suspend them on disk', async () => {
    const w = await world();
    await approved(w);
    const { source } = grants(w);
    const [grant] = source.of(SESSION);
    if (grant === undefined) throw new Error('no grant');
    source.scriptedOn(undefined);
    should(source.holds(grant, LOGIN)).be.false();
    await settled();
    should(w.store.document?.rules[0]?.suspended?.because).equal('scripted-origin');
  });

  it('should leave a rule on another site alone when a script runs elsewhere', async () => {
    const w = await world();
    await approved(w);
    const { source } = grants(w);
    const [grant] = source.of(SESSION);
    if (grant === undefined) throw new Error('no grant');
    source.scriptedOn('gitlab.com');
    await settled();
    should(source.holds(grant, LOGIN)).be.true();
  });
});

describe('RuleSignInGrants: the offline re-check before the second match', () => {
  it('should pass a rule whose proof and pinned facts still check out', async () => {
    const w = await world();
    await approved(w);
    const { source } = grants(w);
    should(await source.verify(source.of(SESSION)[0] as never)).deepEqual({ ok: true });
  });

  it('should refuse a record whose body no longer matches its proof (invariant 5: an edited file, as read back)', async () => {
    const w = await world();
    await approved(w);
    const { source } = grants(w);
    const [grant] = source.of(SESSION);
    // A same-user edit that widens the signed body: the next load or the next fill must refuse it.
    const record = w.store.document?.rules[0];
    if (record === undefined || grant === undefined) throw new Error('no rule');
    (w.service as unknown as { fillable(): unknown }).fillable = () => [
      { ...record, body: { ...record.body, scope: { kind: 'any' }, fields: ['username', 'password', 'totp'] } },
    ];
    should(await source.verify(grant)).deepEqual({ ok: false, reason: 'proof-invalid' });
  });

  it('should refuse a rule whose pinned facts drifted, with that reason, and suspend it', async () => {
    const w = await world();
    await approved(w);
    const { source } = grants(w);
    const [grant] = source.of(SESSION);
    if (grant === undefined) throw new Error('no grant');
    // A drift the account follower has not told the rules about yet: the per-fill check finds it on its own.
    w.state.listing = {
      ...w.state.listing,
      signIns: w.state.listing.signIns.map(each => (each.id === GITHUB ? { ...each, recipeVersion: 4 } : each)),
    } as never;
    should(await source.verify(grant)).deepEqual({ ok: false, reason: 'recipe-changed' });
    await settled();
    should(w.store.document?.rules[0]?.suspended?.because).equal('recipe-changed');
  });

  it('should fill nothing and suspend nothing while the registry or the accounts cannot be read', async () => {
    const w = await world();
    await approved(w);
    const { source } = grants(w);
    const [grant] = source.of(SESSION);
    if (grant === undefined) throw new Error('no grant');
    w.proofs.broken = true;
    should(await source.verify(grant)).deepEqual({ ok: false });
    w.proofs.broken = false;
    w.state.listingBroken = true;
    should(await source.verify(grant)).deepEqual({ ok: false });
    should(w.store.document?.rules[0]?.suspended).be.undefined();
  });

  it('should say a rule revoked since is no longer there, and suspend nothing', async () => {
    const w = await world();
    const { view } = await approved(w);
    const { source } = grants(w);
    const [grant] = source.of(SESSION);
    if (grant === undefined) throw new Error('no grant');
    await w.service.revoke(deviceOwner(), view.id);
    should(await source.verify(grant)).deepEqual({ ok: false, reason: 'expired' });
  });
});

describe('RuleSignInGrants: uses, stops and the stamped project', () => {
  it('should count a use the moment it is spent, before the rule service has written it (invariant 21)', async () => {
    const w = await world();
    await approved(w, { signIn: GITHUB, fields: ['username', 'password'], uses: 1 });
    const { source } = grants(w);
    const [grant] = source.of(SESSION);
    if (grant === undefined) throw new Error('no grant');
    let release: () => void = () => undefined;
    w.store.beforeWrite = async () => await new Promise<void>(resolve => (release = resolve));
    source.used(grant, NOW, SESSION);
    should(source.of(SESSION)[0]).match({ remaining: 0, state: 'used-up' });
    should(source.holds(grant, LOGIN)).be.false();
    release();
    w.store.beforeWrite = undefined;
    await settled();
    should(w.store.document?.rules[0]?.usage).match({ count: 1, lastSession: SESSION });
    should(source.of(SESSION)[0]).match({ remaining: 0, state: 'used-up' });
  });

  it('should suspend a rule for a miss that suspends, at its revision only, and never for one that only asks', async () => {
    const w = await world();
    await approved(w);
    const { source } = grants(w);
    const [grant] = source.of(SESSION);
    if (grant === undefined) throw new Error('no grant');
    await source.stopped(grant, 'rate');
    await source.stopped(grant, 'out-of-scope');
    should(w.store.document?.rules[0]?.suspended).be.undefined();
    await source.stopped(grant, 'form-changed');
    should(w.store.document?.rules[0]?.suspended?.because).equal('form-changed');
  });

  it('should read only a STAMPED project: none, Unfiled or an unknown session is no project', async () => {
    const facts = (projectId?: string) => ({
      read: async () => ({ cwd: '/w', ...(projectId === undefined ? {} : { projectId: projectId as never }) }),
    });
    should(await stampedProjectOf(facts(PROJECT), SESSION)).equal(PROJECT);
    should(await stampedProjectOf(facts(), SESSION)).be.undefined();
    should(await stampedProjectOf(facts(UNFILED_PROJECT_ID), SESSION)).be.undefined();
    should(await stampedProjectOf({ read: async () => null }, SESSION)).be.undefined();
    should(await stampedProjectOf({ read: async () => Promise.reject(new Error('down')) }, SESSION)).be.undefined();
  });
});

describe('RuleSignInGrants: every answer of the rule service, refused as it should be', () => {
  /** A rule source over a fake rule service: what a fill sees of each answer it can give. */
  function faked(check: () => Promise<string>, extra: { warn?: (message: string) => void } = {}) {
    const ledger = new SignInGrantLedger();
    const rules = {
      fillable: () => [],
      verified: () => true,
      fillCheck: check,
      used: async () => undefined,
      suspend: async () => undefined,
      scriptedOn: async () => {
        throw new Error('the rules file cannot be written');
      },
      scriptedEverywhere: async () => {
        throw new Error('the rules file cannot be written');
      },
    } as never;
    return new RuleSignInGrants({
      rules,
      ledger,
      keys: async account => (account === 'GITHUB_WORK' ? (KEY as AccountKey) : Promise.reject(new Error('down'))),
      advertised: () => true,
      stampedProject: async () => undefined,
      clock: { now: () => NOW },
      ...extra,
    });
  }
  const grant = {
    id: 'rule:sr_000000000000000000000001:1',
    source: 'rule',
    rule: { id: 'sr_000000000000000000000001', revision: 1 },
  } as never;

  it('should map every re-check answer to a refusal, and only `ok` to a fill', async () => {
    const answers: [string, unknown][] = [
      ['ok', { ok: true }],
      ['unknown', { ok: false }],
      ['gone', { ok: false, reason: 'expired' }],
      ['suspended', { ok: false, reason: 'suspended' }],
      ['store-write-failed', { ok: false, reason: 'suspended' }],
      ['passkey-removed', { ok: false, reason: 'proof-invalid' }],
      ['form-changed', { ok: false, reason: 'form-changed' }],
    ];
    for (const [answer, verdict] of answers) should(await faked(async () => answer).verify(grant)).deepEqual(verdict);
    // A re-check that throws can't say yes; nor can a grant that names no rule.
    should(await faked(async () => Promise.reject(new Error('down'))).verify(grant)).deepEqual({ ok: false });
    should(await faked(async () => 'ok').verify({ id: 'rule:x:1', source: 'rule' } as never)).deepEqual({
      ok: false,
    });
  });

  it('should hold nothing for a grant that names no rule, and refuse no stop or use it cannot place', async () => {
    const source = faked(async () => 'ok');
    const nameless = { id: 'rule:x:1', source: 'rule' } as never;
    should(source.holds(nameless, LOGIN)).be.false();
    source.used(nameless, NOW, SESSION);
    await source.stopped(nameless, 'form-changed');
    should(source.of(SESSION)).deepEqual([]);
  });

  it('should say so when a page script’s taint could not be saved, and still refuse in memory', async () => {
    const warnings: string[] = [];
    const source = faked(async () => 'ok', { warn: message => void warnings.push(message) });
    source.scriptedOn('github.com');
    source.scriptedOn(undefined);
    await settled();
    should(warnings).have.length(2);
    should(source.scriptedOrigins().hosts.get('github.com')).equal(NOW);
    should(source.scriptedOrigins().everywhere).equal(NOW);
  });

  it('should read an account’s key, or nothing when the store cannot say', async () => {
    const source = faked(async () => 'ok');
    should(await source.keyOf('GITHUB_WORK' as never)).equal(KEY);
    should(await source.keyOf('OTHER' as never)).be.undefined();
  });
});

describe('RuleSignInGrants: two uses in flight, and a rule past its end', () => {
  it('should count two uses spent before either is written, and forget them once both are', async () => {
    const w = await world();
    await approved(w, { signIn: GITHUB, fields: ['username', 'password'], uses: 3 });
    const { source } = grants(w);
    const [grant] = source.of(SESSION);
    if (grant === undefined) throw new Error('no grant');
    let release: () => void = () => undefined;
    w.store.beforeWrite = async () => await new Promise<void>(resolve => (release = resolve));
    source.used(grant, NOW, SESSION);
    source.used(grant, NOW, OTHER);
    should(source.of(SESSION)[0]?.remaining).equal(1);
    w.store.beforeWrite = undefined;
    release();
    await settled();
    should(w.store.document?.rules[0]?.usage.count).equal(2);
    should(source.of(SESSION)[0]?.remaining).equal(1);
  });

  it('should hold nothing for a rule past its end, though the grant was read while it was in force', async () => {
    const w = await world();
    await approved(w);
    const { source } = grants(w);
    const [grant] = source.of(SESSION);
    if (grant === undefined) throw new Error('no grant');
    should(source.holds(grant, LOGIN)).be.true();
    should(source.holds(grant, { ...LOGIN, now: NOW + 31 * 86_400_000 })).be.false();
  });
});

describe('RuleSignInGrants: no fill anywhere while an agent script runs (secrev-1282a M2)', () => {
  it('should refuse every rule while any script runs, and hold again once each one has ended', async () => {
    const w = await world();
    await approved(w);
    const { source } = grants(w);
    const [grant] = source.of(SESSION);
    if (grant === undefined) throw new Error('no grant');
    const one = source.running();
    const two = source.running();
    should(source.holds(grant, LOGIN)).be.false();
    one();
    one();
    should(source.holds(grant, LOGIN)).be.false();
    two();
    should(source.holds(grant, LOGIN)).be.true();
  });
});

describe('SignInRuleService.fillCheck: a check that cannot be made drops the older answer (secrev-1282a M1)', () => {
  it('should leave the rule unverified after an unreadable registry, until a sweep settles it', async () => {
    const w = await world();
    const { view } = await approved(w);
    const rule = view.id as SignInRuleId;
    should(w.service.verified(rule, 1)).be.true();
    w.proofs.broken = true;
    should(await w.service.fillCheck(rule, 1)).equal('unknown');
    should(w.service.verified(rule, 1)).be.false();
    should(w.store.document?.rules[0]?.suspended).be.undefined();
    w.proofs.broken = false;
    await w.service.sweepRules();
    should(w.service.verified(rule, 1)).be.true();
  });

  it('should leave the rule unverified after unreadable accounts too', async () => {
    const w = await world();
    const { view } = await approved(w);
    const rule = view.id as SignInRuleId;
    w.state.listingBroken = true;
    should(await w.service.fillCheck(rule, 1)).equal('unknown');
    should(w.service.verified(rule, 1)).be.false();
  });
});
