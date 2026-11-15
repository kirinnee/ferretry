/**
 * WHAT THE VAULT READS THROUGH `input.saved:saved` → `grants()` (docs/input-requests.md, "Task plan fills", "Standing rule
 * fills"): the real hook, the combined source, the real rule service and the real matcher, with a fake plan service. A
 * plan line or a rule that covers a card is a match the Vault types under; a form that changed, a revoked rule, a
 * suspended one, a script that ran and an Accounts that provides no source are not, so the card is the owner's.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import type {
  AccountId,
  AccountKey,
  AccountSummary,
  SignInRuleId,
  SignInSummary,
} from '../../../contract/routes/index.ts';
import type { InputRequestField } from '../../../daemon/lib/vault-inputs.ts';
import { AccountsSavedLogins } from '../../../daemon/lib/saved-logins-hook.ts';
import { SignInGrantLedger } from '../../../daemon/lib/sign-in-grants/ledger.ts';
import {
  type GrantSighting,
  matchSignInGrant,
  NO_SCRIPTED_ORIGINS,
} from '../../../daemon/lib/sign-in-grants/matcher.ts';
import {
  type PlanGrantLines,
  PlanSignInGrants,
  type SignInGrantSource,
} from '../../../daemon/lib/sign-in-grants/plans.ts';
import { RuleSignInGrants } from '../../../daemon/lib/sign-in-grants/rules.ts';
import { CombinedSignInGrants } from '../../../daemon/lib/sign-in-grants/sources.ts';
import type { ApprovedSignInLine } from '../../../daemon/lib/task-plans/service.ts';
import { AccountVault, LoginDirectory } from '../../unit/daemon/lib.ts';
import { deviceOwner, GITHUB, KEY, NOW, approved, world } from '../../unit/daemon/sign-in-rules/support.ts';
import { CLOCK, CountingSealed, FakeSecretCipher, MemoryLoginIndex } from '../../unit/daemon/support.ts';

const SESSION = 'mvv6b4qw-49d0158d';
const PLAN = 'ab'.repeat(16);
const LOGIN = { sessionId: SESSION, project: undefined, roles: ['username', 'password'] as const, now: NOW };

const planLine = (over: Partial<ApprovedSignInLine> = {}): ApprovedSignInLine => ({
  planId: PLAN,
  sessionId: SESSION,
  line: 0,
  kind: 'sign-in',
  state: 'approved',
  signIn: GITHUB,
  fields: ['password', 'username'],
  remaining: 1,
  pins: { accountKey: KEY as AccountKey, placeKeys: ['github.com'] },
  expiresAt: NOW + 3_600_000,
  ...over,
});

/** The sources as `buildRules` composes them (one ledger), reached the way the Vault reaches them: through the hook. */
async function composed(lines: () => readonly ApprovedSignInLine[]) {
  const w = await world();
  const ledger = new SignInGrantLedger();
  const plans: PlanGrantLines = {
    signInLines: () => lines(),
    signInLineHeld: () => true,
    lineUsed: () => undefined,
    lineStopped: async () => undefined,
  };
  const keys = async (): Promise<AccountKey | undefined> => KEY as AccountKey;
  const grants = new CombinedSignInGrants(
    new PlanSignInGrants(plans, keys, ledger),
    new RuleSignInGrants({
      rules: w.service,
      ledger,
      keys,
      terminal: () => true,
      stampedProject: async () => undefined,
      clock: { now: () => w.clock.now },
    }),
    ledger,
  );
  const index = new MemoryLoginIndex();
  const sealed = new CountingSealed();
  const cipher = new FakeSecretCipher();
  const hook = new AccountsSavedLogins({
    logins: new LoginDirectory(index, sealed, cipher, CLOCK),
    vault: new AccountVault(index, sealed, cipher),
    choice: { of: async () => ({}) },
    grants,
  });
  return { w, hook, offered: hook.grants() as SignInGrantSource };
}

const FIELDS: InputRequestField[] = [
  { id: 'user', label: 'Username', sensitivity: 'plain' },
  { id: 'pass', label: 'Password', sensitivity: 'secret' },
];
const AT = '2026-10-01T00:00:00.000Z';
const account = {
  id: 'GITHUB' as AccountId,
  label: 'GitHub',
  username: 'kirinnee',
  fields: { password: true },
  factors: [],
  signIns: [GITHUB],
  createdAt: AT,
  updatedAt: AT,
} as AccountSummary;
const site = {
  id: GITHUB,
  account: 'GITHUB' as AccountId,
  place: { kind: 'site', domains: ['github.com'], match: ['github.com'] },
  method: { kind: 'password' },
  createdAt: AT,
  updatedAt: AT,
} as SignInSummary;
const field = (fieldId: string, attrs: object) => ({
  fieldId,
  frameOrigin: 'https://github.com',
  frameId: 'main',
  backendNodeId: fieldId === 'pass' ? 12 : 11,
  field: { tag: 'input', ...attrs },
  box: { x: 0, y: 0, w: 100, h: 30 },
  visible: true,
});

/** A login card at github.com for the sign-in the grants name, as the Vault's fill path sights it. */
const sighting = (): GrantSighting =>
  ({
    sessionId: SESSION,
    facts: {
      kind: 'page',
      pageId: 'p1',
      origin: 'https://github.com',
      secure: true,
      navigationId: 'n1',
      fields: [field('user', { type: 'text' }), field('pass', { type: 'password', name: 'password' })],
    },
    matchKey: 'github.com',
    fields: FIELDS,
    listing: { accounts: [account], signIns: [site] },
    keys: new Map([['GITHUB' as AccountId, KEY as AccountKey]]),
    scripted: false,
    scriptedOrigins: NO_SCRIPTED_ORIGINS,
    now: NOW,
  }) as GrantSighting;

describe('Accounts offers the Vault what the owner approved in advance, through the hook', () => {
  it('I131 should offer the one combined source: the ticked plan line and the standing rule, soonest to expire first', async () => {
    const { w, offered } = await composed(() => [planLine()]);
    const { view } = await approved(w);

    should(offered.enabled()).equal(true);
    should(offered.of(SESSION).map(grant => grant.id)).eql([`plan:${PLAN}:0`, `rule:${view.id}:1`]);
    should(await offered.keyOf('GITHUB_WORK' as AccountId)).equal(KEY);
    should(offered.holds(offered.of(SESSION)[1] as never, LOGIN)).equal(true);
  });

  it('should leave every card to the owner when no source is provided (Accounts built none)', () => {
    const index = new MemoryLoginIndex();
    const bare = new AccountsSavedLogins({
      logins: new LoginDirectory(index, new CountingSealed(), new FakeSecretCipher(), CLOCK),
      choice: { of: async () => ({}) },
    });

    should(bare.grants()).equal(undefined);
  });

  it('should fill the card a plan line covers, and leave it to the owner once the recipe changed since the owner ticked it', async () => {
    const covering = await composed(() => [planLine()]);
    const stale = await composed(() => [
      planLine({ pins: { accountKey: KEY as AccountKey, placeKeys: ['github.com'], recipeVersion: 4 } }),
    ]);

    const filled = matchSignInGrant(covering.offered.of(SESSION)[0] as never, sighting(), new Map());
    const missed = matchSignInGrant(stale.offered.of(SESSION)[0] as never, sighting(), new Map());

    should(filled).match({ ok: true, account: 'GITHUB', fills: ['username', 'password'] });
    should(missed).match({ ok: false, reason: 'recipe-changed' });
  });

  it('should stop offering a standing rule the owner revoked, so its sign-in is the owner’s again', async () => {
    const { w, offered } = await composed(() => []);
    const { view } = await approved(w);
    const [grant] = offered.of(SESSION);
    should(offered.holds(grant as never, LOGIN)).equal(true);

    await w.service.revoke(deviceOwner(), view.id as SignInRuleId);

    should(offered.of(SESSION)).eql([]);
    should(offered.holds(grant as never, LOGIN)).equal(false);
  });

  it('should refuse every rule while an agent script runs, and again once it ended', async () => {
    const { w, offered } = await composed(() => []);
    await approved(w);
    const [grant] = offered.of(SESSION);

    const end = offered.running?.() ?? (() => undefined);

    should(offered.holds(grant as never, LOGIN)).equal(false);
    should(offered.scriptedOrigins().running).equal(true);
    end();
    should(offered.holds(grant as never, LOGIN)).equal(true);
    should(offered.scriptedOrigins().running).equal(undefined);
  });

  it('should stop the rules pinned where a page script ran, in RAM at once and on disk after', async () => {
    const { w, offered } = await composed(() => []);
    await approved(w);
    const [grant] = offered.of(SESSION);

    offered.scriptedOn?.('github.com');

    should(offered.holds(grant as never, LOGIN)).equal(false);
    should(offered.scriptedOrigins().hosts.has('github.com')).equal(true);
    await new Promise(resolve => setTimeout(resolve, 5));
    should(w.store.document?.rules[0]?.suspended).not.equal(undefined);
    should(offered.of(SESSION)[0]?.state).equal('stopped');
  });

  it('should have nothing to stop of a script when only a plan line is offered', async () => {
    const w = await world();
    const ledger = new SignInGrantLedger();
    const planOnly = new PlanSignInGrants(
      {
        signInLines: () => [],
        signInLineHeld: () => true,
        lineUsed: () => undefined,
        lineStopped: async () => undefined,
      },
      async () => undefined,
      ledger,
    );
    const combined = new CombinedSignInGrants(
      planOnly,
      new RuleSignInGrants({
        rules: w.service,
        ledger,
        keys: async () => undefined,
        stampedProject: async () => undefined,
        clock: { now: () => w.clock.now },
      }),
      ledger,
    );

    combined.running()();
    combined.scriptedOn('github.com');

    should(combined.scriptedOrigins().hosts.has('github.com')).equal(true);
  });
});
