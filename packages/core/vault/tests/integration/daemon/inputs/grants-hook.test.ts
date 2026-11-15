import { describe, it } from 'bun:test';
import should from 'should';
import type { SavedLoginsProvider } from '../../../../contract/index.ts';
import { SignInGrantsThroughHook } from '../../../../daemon/adapters/inputs/grants.ts';
import {
  type ScriptedOriginsView,
  type SignInGrant,
  SignInGrantLedger,
  type SignInGrantSource,
} from '../../../../daemon/lib/inputs/borrowed-grants.ts';
import { MachineScripts } from '../../../../daemon/lib/inputs/machine-scripts.ts';
import {
  account,
  grant,
  KEY,
  NOW,
  page,
  ruleGrant,
  SESSION,
  site,
} from '../../../unit/daemon/inputs/grant-fixtures.ts';
import { PAGE_LOGIN, PASSWORD, USERNAME, world } from '../../../unit/daemon/inputs/world.ts';

/**
 * What the owner approved in advance, reaching the Vault's fill path through `input.saved:saved` → `grants()`: the real
 * hook adapter and the real input service over a provider that is a fake. A covered sign-in is typed without a tap; a
 * mismatch, a revoked grant, an Accounts that is off and anything that is not a grant source all leave the card to the
 * owner (fail closed).
 */
const github = () => ({ accounts: [account()], signIns: [site()] });

interface Offered {
  grants: SignInGrant[];
  enabled: boolean;
  used: string[];
  stopped: string[];
  ended: number;
  scripted: (string | undefined)[];
  scripts: ScriptedOriginsView;
  verify: { ok: true } | { ok: false; reason?: string };
}

/** A grant source as Accounts builds one, answering from `offered`: the part of Accounts the Vault never sees. */
function source(offered: Offered, ledger = new SignInGrantLedger()): SignInGrantSource {
  return {
    enabled: () => offered.enabled,
    of: () => offered.grants,
    keyOf: async () => KEY,
    ledger,
    used: (each, _at, sessionId) => void offered.used.push(`${each.id}@${sessionId}`),
    stopped: async (each, because) => void offered.stopped.push(`${each.id}:${because}`),
    verify: async () => offered.verify as never,
    holds: () => true,
    projectOf: async () => 'ferretry',
    scriptedOrigins: () => offered.scripts,
    running: () => {
      offered.ended -= 1;
      return () => {
        offered.ended += 1;
      };
    },
    scriptedOn: host => void offered.scripted.push(host),
  };
}

const offering = (over: Partial<Offered> = {}): Offered => ({
  grants: [grant()],
  enabled: true,
  used: [],
  stopped: [],
  ended: 0,
  scripted: [],
  scripts: { hosts: new Map() },
  verify: { ok: true },
  ...over,
});

function provider(grants: () => unknown): SavedLoginsProvider {
  return {
    listing: async () => ({ accounts: [], signIns: [] }),
    fill: async () => '',
    save: async () => undefined,
    choice: async () => ({}),
    observeSignIn: async () => undefined,
    checkedByUse: async () => undefined,
    grants,
  };
}

/** The provider Accounts is: one source (so one ledger) answered on every lookup, as the hook looks it up. */
const over = (offered: Offered) => {
  const built = source(offered);
  return () => provider(() => built);
};

/** A page login card raised under the hook, looked up on every call from `current` (undefined: Accounts is off). */
async function raise(current: () => SavedLoginsProvider | undefined) {
  const hook = new SignInGrantsThroughHook(current);
  const w = world({ facts: page(), grantPort: hook, accounts: github() });
  const view = await w.service.raise(SESSION, PAGE_LOGIN);
  return { w, view, hook };
}

describe('a sign-in the owner approved in advance, through the hook', () => {
  it('I131 should type the username and password without a tap and spend one use of the grant Accounts holds', async () => {
    const offered = offering();

    const { w, view } = await raise(over(offered));

    should(view.state).equal('delivered');
    should(w.writes.map(write => write.values)).eql([[USERNAME, PASSWORD]]);
    should(offered.used).eql([`${offered.grants[0]?.id}@${SESSION}`]);
  });

  it('should leave the card to the owner and stop the line when the grant does not fit the form', async () => {
    const line = grant({ pins: { placeKeys: ['github.com'], recipeVersion: 4, identities: undefined } });
    const offered = offering({ grants: [line] });

    const { w, view } = await raise(over(offered));

    should(view.state).equal('pending');
    should(w.writes).eql([]);
    should(offered.stopped).eql([`${line.id}:recipe-changed`]);
  });

  it('should leave the card to the owner once the owner revoked the grant (nothing in force)', async () => {
    const offered = offering({ grants: [] });

    const { w, view } = await raise(over(offered));

    should(view.state).equal('pending');
    should(w.writes).eql([]);
    should(offered.used).eql([]);
  });

  it('should leave the card to the owner when the grants are switched off', async () => {
    const { w, view } = await raise(() => provider(() => source(offering({ enabled: false }))));

    should(view.state).equal('pending');
    should(w.writes).eql([]);
  });

  it('should leave the card to the owner and type nothing when Accounts is off', async () => {
    const { w, view, hook } = await raise(() => undefined);

    should(view.state).equal('pending');
    should(w.writes).eql([]);
    should(hook.enabled()).equal(false);
  });

  it('should leave the card to the owner when the provider offers no source', async () => {
    const { w, view } = await raise(() => provider(() => undefined));

    should(view.state).equal('pending');
    should(w.writes).eql([]);
  });

  it('should read what is not a grant source as no source: a member missing, no ledger, not an object', async () => {
    const whole = source(offering());
    const { ledger: _ledger, ...noLedger } = whole;
    const { of: _of, ...noOf } = whole;
    const offers: unknown[] = [{ ...noOf, ledger: whole.ledger }, noLedger, { ...whole, ledger: null }, 'grants', null];

    for (const offered of offers) {
      const hook = new SignInGrantsThroughHook(() => provider(() => offered));
      should(hook.enabled()).equal(false);
      should(hook.of(SESSION)).eql([]);
    }
  });

  it('should treat a provider or a source that throws as no grants, never as a broken raise', async () => {
    const throwing = (): never => {
      throw new Error('the grants cannot be read');
    };
    const offered = offering();
    const broken: SignInGrantSource = {
      ...source(offered),
      enabled: throwing,
      of: throwing,
      scriptedOrigins: throwing,
    };

    const byProvider = await raise(() => provider(throwing));
    const bySource = await raise(() => provider(() => broken));

    should(byProvider.view.state).equal('pending');
    should(bySource.view.state).equal('pending');
    should(bySource.w.writes).eql([]);
    should(bySource.hook.scriptedOrigins().running).equal(true);
    should(byProvider.hook.scriptedOrigins()).eql({ hosts: new Map() });
  });
});

describe('the hook as the Vault’s grant source, member by member', () => {
  it('should hand every member to the source Accounts offers now', async () => {
    const offered = offering({ scripts: { hosts: new Map([['github.com', 7]]) }, verify: { ok: false } });
    const hook = new SignInGrantsThroughHook(over(offered));
    const line = offered.grants[0] as SignInGrant;

    should(hook.enabled()).equal(true);
    should(hook.of(SESSION)).eql(offered.grants);
    should(await hook.keyOf('GITHUB' as never)).equal(KEY);
    hook.used(line, 1, SESSION);
    await hook.stopped(line, 'form-changed' as never);
    should(await hook.verify(line)).eql({ ok: false });
    should(hook.holds(line, { sessionId: SESSION, project: undefined, roles: ['username'], now: 1 })).equal(true);
    should(await hook.projectOf(SESSION)).equal('ferretry');
    should(hook.scriptedOrigins().hosts.get('github.com')).equal(7);
    should(offered.used).eql([`${line.id}@${SESSION}`]);
    should(offered.stopped).eql([`${line.id}:form-changed`]);
  });

  it('should answer "no" to everything it is asked when Accounts offers no source (fail closed)', async () => {
    const hook = new SignInGrantsThroughHook(() => undefined);
    const line = grant();

    should(hook.enabled()).equal(false);
    should(hook.of(SESSION)).eql([]);
    should(await hook.keyOf('GITHUB' as never)).equal(undefined);
    hook.used(line, 1, SESSION);
    await hook.stopped(line, 'form-changed' as never);
    should(await hook.verify(line)).eql({ ok: false });
    should(hook.holds(line, { sessionId: SESSION, project: undefined, roles: ['password'], now: 1 })).equal(false);
    should(await hook.projectOf(SESSION)).equal(undefined);
    should(hook.scriptedOrigins()).eql({ hosts: new Map() });
    should(hook.ledger).be.instanceOf(SignInGrantLedger);
    should(hook.ledger).equal(hook.ledger);
  });

  it('should tell the source of every script, so no standing rule fills while one runs or where one ran', async () => {
    const offered = offering();
    const hook = new SignInGrantsThroughHook(over(offered));

    const end = hook.running();
    should(offered.ended).equal(-1);
    end();
    hook.scriptedOn('github.com');
    hook.scriptedOn(undefined);

    should(offered.ended).equal(0);
    should(offered.scripted).eql(['github.com', undefined]);
  });

  it('should have nothing to stop when the source has no standing rule or Accounts is off', async () => {
    const { running: _running, scriptedOn: _scriptedOn, ...planOnly } = source(offering());
    const plans = new SignInGrantsThroughHook(() => provider(() => planOnly));
    const off = new SignInGrantsThroughHook(() => undefined);

    for (const hook of [plans, off]) {
      hook.running()();
      hook.scriptedOn('github.com');
    }

    should(plans.ledger).equal(planOnly.ledger);
  });
});

/**
 * A page script that ran while Accounts was not listening (off, or a plugin-graph restart) is still a script that ran:
 * the Vault's own record of them (Browsers tells it) is what a standing rule is held to as well, and a fill is typed
 * on the one source it started with.
 */
describe('a standing rule and the page scripts the Vault saw while Accounts was away', () => {
  const rule = (over: Partial<SignInGrant> = {}) => ruleGrant(over);

  it('should fill under the rule when no page script ran (the control for the cases below)', async () => {
    const offered = offering({ grants: [rule()] });
    const w = world({
      facts: page(),
      grantPort: new SignInGrantsThroughHook(over(offered)),
      scripts: new MachineScripts(() => NOW),
      accounts: github(),
    });

    const view = await w.service.raise(SESSION, PAGE_LOGIN);

    should(view.state).equal('delivered');
    should(offered.used).eql([`${rule().id}@${SESSION}`]);
  });

  it('should not fill when a script was reported with no source, and a source appeared after it', async () => {
    // Accounts is off: Browsers' report reaches the hook (dropped, nobody listens) and the Vault's own record.
    const scripts = new MachineScripts(() => NOW);
    const offered = offering({ grants: [rule()] });
    let live: SignInGrantSource | undefined;
    const hook = new SignInGrantsThroughHook(() => (live === undefined ? undefined : provider(() => live)));
    hook.scriptedOn('github.com');
    scripts.scriptedOn('github.com');
    // Accounts comes back as a new instance that knows nothing of the script.
    live = source(offered);
    should(live.scriptedOrigins().hosts.size).equal(0);
    const w = world({ facts: page(), grantPort: hook, scripts, accounts: github() });

    const view = await w.service.raise(SESSION, PAGE_LOGIN);
    const request = await w.pending();

    should(view.state).equal('pending');
    should(w.writes).eql([]);
    should(offered.used).eql([]);
    should(request.preapproval).match({ by: 'rule', outcome: 'did-not-apply', reason: 'scripted-origin' });
  });

  it('should not fill while a script runs across a source swap, and fill once it has ended', async () => {
    const scripts = new MachineScripts(() => NOW);
    const before = offering({ grants: [rule()] });
    const after = offering({ grants: [rule()] });
    let live = source(before);
    const hook = new SignInGrantsThroughHook(() => provider(() => live));
    // The script starts under the first instance; the graph restarts, so the second one has never heard of it.
    const end = scripts.running();
    live = source(after);
    should(live.scriptedOrigins().running).equal(undefined);

    const during = world({ facts: page(), grantPort: hook, scripts, accounts: github() });
    const blocked = await during.service.raise(SESSION, PAGE_LOGIN);
    should(blocked.state).equal('pending');
    should(during.writes).eql([]);
    should(after.used).eql([]);
    end();
    const later = world({ facts: page(), grantPort: hook, scripts, accounts: github() });
    const filled = await later.service.raise(SESSION, PAGE_LOGIN);

    should(filled.state).equal('delivered');
    should(after.used).eql([`${rule().id}@${SESSION}`]);
  });

  it('should settle a fill on the source it reserved on, so a one-use rule cannot fill again after a swap', async () => {
    const oneUse = rule({ remaining: 1 });
    const first = offering({ grants: [oneUse] });
    const second = offering({ grants: [oneUse] });
    const firstLedger = new SignInGrantLedger();
    // Once a use is recorded the rule is used up, as Accounts reports it.
    const firstSource: SignInGrantSource = {
      ...source(first, firstLedger),
      of: () => (first.used.length > 0 ? [{ ...oneUse, state: 'used-up', remaining: 0 }] : first.grants),
    };
    let live = firstSource;
    const hook = new SignInGrantsThroughHook(() => provider(() => live));
    const w = world({ facts: page(), grantPort: hook, accounts: github() });
    // The graph restarts while the value is being typed: the second instance has its own, empty ledger.
    w.state.onType = () => {
      live = source(second);
    };

    const view = await w.service.raise(SESSION, PAGE_LOGIN);
    w.state.onType = undefined;
    live = firstSource;
    const again = await w.service.raise(SESSION, PAGE_LOGIN);

    should(view.state).equal('delivered');
    should(first.used).eql([`${oneUse.id}@${SESSION}`]);
    should(second.used).eql([]);
    should(again.state).equal('pending');
    should(w.writes.map(write => write.values)).eql([[USERNAME, PASSWORD]]);
  });
});

describe('the hook held fixed for one fill', () => {
  it('should answer from the source in effect when it was bound, whatever Accounts offers after', async () => {
    const first = source(offering());
    const second = source(offering({ enabled: false }));
    let live: SignInGrantSource | undefined = first;
    const hook = new SignInGrantsThroughHook(() => (live === undefined ? undefined : provider(() => live)));

    const bound = hook.bound();
    live = second;
    const offAfter = new SignInGrantsThroughHook(() => undefined).bound();

    should(bound.ledger).equal(first.ledger);
    should(bound.enabled()).equal(true);
    should(hook.enabled()).equal(false);
    should(bound.bound?.().ledger).equal(first.ledger);
    should(offAfter.enabled()).equal(false);
    should(offAfter.ledger).be.instanceOf(SignInGrantLedger);
  });
});
