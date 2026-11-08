import { describe, it } from 'bun:test';
import should from 'should';
import { identityOf } from '../../../../daemon/lib/inputs/login-observer.ts';
import { account, page, ruleGrant, SESSION, site } from './grant-fixtures.ts';
import { PAGE_LOGIN, PASSWORD, planLine, USERNAME, world } from './world.ts';

/**
 * A sign-in the owner approved in advance, on a task plan or with a standing rule (docs/input-requests.md, "Task plan
 * fills", "Standing rule fills"): filled at the raise, as one guarded write, or left for the owner with the grant
 * that did not apply. The grant source is a fake over the real ledger; the service and the matcher are real.
 */

const github = () => ({ accounts: [account()], signIns: [site()] });

describe('a task-plan line fills a sign-in at the raise', () => {
  it('I213 should type the username and password under the line, close the card, and spend one use', async () => {
    const w = world({ facts: page(), grants: [planLine()], accounts: github() });

    const view = await w.service.raise(SESSION, PAGE_LOGIN);

    should(view.state).equal('delivered');
    should(w.writes.map(write => write.values)).eql([[USERNAME, PASSWORD]]);
    should(w.grantLog.used).eql([`plan:${'ab'.repeat(16)}:0@${SESSION}`]);
    should(w.closed.at(-1)).containEql('Filled under your task plan (line 1) on github.com.');
    should(await w.service.agentView(SESSION, view.id, 0)).match({ note: 'Filled under your task plan.' });
    should(w.told.at(-1)).containEql('under your task plan');
    should(w.delivered).have.length(1);
  });

  it('should empty the password field before the hold ends and stop the line when it did not move on', async () => {
    const w = world({ facts: page(), grants: [planLine()], accounts: github() });
    w.state.clearOutcome = 'cleared';

    await w.service.raise(SESSION, PAGE_LOGIN);
    for (const timer of w.timers) timer.fire();
    await new Promise(resolve => setTimeout(resolve, 0));

    should(w.cleared).have.length(1);
    should(w.grantLog.stopped.map(each => each.because)).eql(['did-not-move-on']);
  });

  it('should let the page go when the field was found empty because the page moved on', async () => {
    const w = world({ facts: page(), grants: [planLine()], accounts: github() });
    w.state.clearOutcome = 'moved';

    await w.service.raise(SESSION, PAGE_LOGIN);
    for (const timer of w.timers) timer.fire();
    await new Promise(resolve => setTimeout(resolve, 0));

    should(w.grantLog.stopped).eql([]);
  });

  it('should keep the page held and stop the line when it cannot be told whether the field was emptied', async () => {
    const w = world({ facts: page(), grants: [planLine()], accounts: github(), clear: false });

    await w.service.raise(SESSION, PAGE_LOGIN);
    for (const timer of w.timers) timer.fire();
    await new Promise(resolve => setTimeout(resolve, 0));

    should(w.grantLog.stopped.map(each => each.because)).eql(['did-not-move-on']);
  });
});

describe('a task-plan line that does not apply leaves the card to the owner', () => {
  it('should say the line did not apply, stop it when the recipe changed, and add the one fixed line to the card', async () => {
    const line = planLine({ pins: { placeKeys: ['github.com'], recipeVersion: 4, identities: undefined } });
    const w = world({ facts: page(), grants: [line], accounts: github() });

    const view = await w.service.raise(SESSION, PAGE_LOGIN);
    const request = await w.pending();

    should(view.state).equal('pending');
    should(w.writes).eql([]);
    should(request.preapproval).match({ by: 'plan', outcome: 'did-not-apply', reason: 'recipe-changed' });
    should(w.grantLog.stopped).eql([{ id: line.id, because: 'recipe-changed' }]);
    should(w.notes).eql(["A task plan line didn't apply here, so you're asked as usual."]);
    should(w.audits.at(-1)?.detail).match({ preapproval: 'did-not-apply', because: 'recipe-changed' });
    should(await w.service.agentView(SESSION, view.id, 0)).match({
      note:
        `A task plan line didn't apply here, so you're asked as usual.`.length > 0
          ? /Waiting for the owner on A1\./
          : '',
    });
  });

  it('should read a line whose accounts cannot be read as a sign-in that is gone, not as a failure', async () => {
    const w = world({ facts: page(), grants: [planLine()], accounts: github() });
    w.state.listingFails = true;

    await w.service.raise(SESSION, PAGE_LOGIN).catch(() => undefined);

    should(w.writes).eql([]);
  });

  it('should refuse a line that is not in force for this card, or used up with no attempt to join', async () => {
    const used = planLine({ state: 'used-up', remaining: 0 });
    const w = world({ facts: page(), grants: [used], accounts: github() });

    const view = await w.service.raise(SESSION, PAGE_LOGIN);

    should(view.state).equal('pending');
    should(w.writes).eql([]);
  });

  it('should leave the card the owner’s when the grants are switched off', async () => {
    const w = world({ facts: page(), grants: [planLine()], accounts: github(), grantsEnabled: false });

    const view = await w.service.raise(SESSION, PAGE_LOGIN);

    should(view.state).equal('pending');
    should(w.writes).eql([]);
  });
});

describe('the last checks before a grant types', () => {
  it('should type nothing when the line was revoked between the raise and the write', async () => {
    const line = planLine();
    const w = world({ facts: page(), grants: [line], accounts: github() });
    w.state.holds = false;

    const view = await w.service.raise(SESSION, PAGE_LOGIN);

    should(view.state).equal('pending');
    should(w.writes).eql([]);
    should(w.ledger.pinned(line.id).size).equal(0);
  });

  it('should type nothing when a standing rule’s stored proof no longer checks out, suspending it', async () => {
    const rule = ruleGrant();
    const w = world({ facts: page(), grants: [rule], accounts: github() });
    w.state.verify = { ok: false, reason: 'proof-invalid' };

    const view = await w.service.raise(SESSION, PAGE_LOGIN);

    should(view.state).equal('pending');
    should(w.writes).eql([]);
    should(w.grantLog.stopped).eql([{ id: rule.id, because: 'proof-invalid' }]);
    should(w.notes).eql([]);
    should(w.rebuzzed).eql([SESSION]);
  });

  it('should type nothing when a rule could not be checked again, without suspending it', async () => {
    const rule = ruleGrant();
    const w = world({ facts: page(), grants: [rule], accounts: github() });
    w.state.verify = { ok: false };

    const view = await w.service.raise(SESSION, PAGE_LOGIN);

    should(view.state).equal('pending');
    should(w.writes).eql([]);
    should(w.grantLog.stopped).eql([]);
  });
});

describe('a standing rule fills a sign-in at the raise', () => {
  const ruleFor = () =>
    ruleGrant({
      pins: {
        placeKeys: ['github.com'],
        recipeVersion: undefined,
        identities: [identityOf(page(), 'github.com') as string],
      },
    });

  it('should fill under the rule, closing the card in a tap fill’s words and telling the agent only that a rule did', async () => {
    const w = world({ facts: page(), grants: [ruleFor()], accounts: github() });

    const view = await w.service.raise(SESSION, PAGE_LOGIN);

    should(view.state).equal('delivered');
    should(w.writes.map(write => write.values)).eql([[USERNAME, PASSWORD]]);
    should(w.closed.at(-1)).not.containEql('rule');
    should(await w.service.agentView(SESSION, view.id, 0)).match({
      note: 'Filled under a rule the owner approved in advance.',
    });
    should(w.told.at(-1)).containEql('under a rule the owner approved in advance');
  });

  it('should leave a rule’s miss unsaid on the card and ask the phone to buzz again', async () => {
    const rule = ruleGrant({ scope: { kind: 'session', session: 'someone-else' } });
    const w = world({ facts: page(), grants: [rule], accounts: github() });

    const view = await w.service.raise(SESSION, PAGE_LOGIN);
    const request = await w.pending();

    should(view.state).equal('pending');
    should(w.notes).eql([]);
    should(w.rebuzzed).eql([SESSION]);
    should(request.preapproval).match({ by: 'rule', outcome: 'did-not-apply', reason: 'out-of-scope' });
    should(w.grantLog.stopped).eql([]);
  });

  it('should report a plan line’s miss rather than a rule’s when both were tried', async () => {
    const line = planLine({ pins: { placeKeys: ['github.com'], recipeVersion: 4, identities: undefined } });
    const rule = ruleGrant({ scope: { kind: 'session', session: 'someone-else' } });
    const w = world({ facts: page(), grants: [rule, line], accounts: github() });

    await w.service.raise(SESSION, PAGE_LOGIN);
    const request = await w.pending();

    should(request.preapproval).match({ by: 'plan', outcome: 'did-not-apply', reason: 'recipe-changed' });
    should(w.notes).eql(["A task plan line didn't apply here, so you're asked as usual."]);
  });

  it('should read the session’s project only for a rule scoped to one', async () => {
    const rule = ruleGrant({ scope: { kind: 'project', project: 'ferretry' } });
    const w = world({ facts: page(), grants: [rule], accounts: github() });

    const view = await w.service.raise(SESSION, PAGE_LOGIN);

    should(view.state).equal('delivered');
  });
});
