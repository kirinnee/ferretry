import { describe, it } from 'bun:test';
import { OWNER_ONLY_CODE, STEP_UP_REQUIRED_CODE } from '@ferretry/core-gate/contract';
import { ferretStanding } from '@ferretry/core-gate/contract/testing';
import type { CallStanding, FerretId } from '@ferretry/kernel/contract';
import should from 'should';
import {
  COPY_MAX_RULES,
  type CopyMeta,
  type PasteRuleCreate,
  PASTE_RULE_ERROR_CODES,
  type PasteRuleStageId,
} from '../../../../contract/routes/index.ts';
import {
  type CopyListing,
  type RuleProgramHomes,
  secureCopyRoutes,
} from '../../../../daemon/lib/runtime/mounts/secure-copy.ts';
import { PasteRuleStages } from '../../../../daemon/lib/secure-copy/rule-stages.ts';
import { PasteRuleService } from '../../../../daemon/lib/secure-copy/rules.ts';
import { allowedDevice, driverOf, machine, without } from './driver.ts';
import { HOST, planWorld, SESSION, SIGN_IN_LINE, STORE_PASTE, TERMINAL_PASTE } from './plan-world.ts';

/**
 * The owner's secure-copy routes, driven on the route table with a real PasteRuleService, PasteRuleStages and
 * TaskPlanService. Only the ports are fakes: the rules file, the clock, the copies a session holds, the profile's programs.
 */

const NOW = Date.parse('2026-11-02T09:00:00.000Z');
const GH = { kind: 'command', program: 'gh' } as const;
const TO_TERMINAL: PasteRuleCreate = { from: GH, to: { kind: 'terminal', program: 'vercel' } };
const TO_PAGE: PasteRuleCreate = { from: GH, to: { kind: 'browser', origin: 'https://vercel.com' } };
const TO_STORE: PasteRuleCreate = { from: GH, to: { kind: 'secret', name: 'DEPLOY_TOKEN' } };

const COPY: CopyMeta = {
  name: 'token',
  origin: GH,
  size: 12,
  createdAt: '2026-11-02T08:00:00.000Z',
  expiresAt: '2026-11-02T09:00:00.000Z',
} as unknown as CopyMeta;

interface Options {
  readonly homes?: RuleProgramHomes;
  readonly copies?: CopyListing;
}

async function world(options: Options = {}) {
  let ruleIds = 0;
  let stageIds = 0;
  const rules = new PasteRuleService({
    store: { read: async () => undefined, write: async () => undefined },
    clock: { now: () => NOW },
    ids: { ruleId: () => (++ruleIds).toString(16).padStart(32, '0') },
    warn: () => undefined,
  });
  await rules.load();
  const stages = new PasteRuleStages({
    rules,
    clock: { now: () => NOW },
    stageId: () => `prs_${(++stageIds).toString(16).padStart(24, '0')}` as PasteRuleStageId,
  });
  const planned = planWorld();
  await planned.rules.load();
  const copies: CopyListing = options.copies ?? { list: sessionId => (sessionId === SESSION ? [COPY] : []) };
  const call = driverOf(secureCopyRoutes(copies, rules, planned.plans, stages, options.homes));
  return { rules, stages, plans: planned.plans, call };
}

type World = Awaited<ReturnType<typeof world>>;

/** A paired device's standing, its claims answering as the test says. */
const phone = (claims: Parameters<typeof allowedDevice>[0] = {}) => allowedDevice(claims, 'phone-1');
const proving = (claimed: string[] = []) =>
  phone({
    claimFreshStepUp: ((act: string, subject: string) => {
      claimed.push(`${act}:${subject}`);
      return true;
    }) as CallStanding['claimFreshStepUp'],
  });

async function staged(w: World, request: PasteRuleCreate = TO_TERMINAL, standing: CallStanding = phone()) {
  const answer = await w.call('POST', '/v1/copy-rules/stages', { body: request, standing });
  should(answer.status).equal(201);
  return (answer.body as { stage: PasteRuleStageId }).stage;
}

const stageRoute = '/v1/copy-rules/stages/:stage';

describe('the copies a session holds', () => {
  it('should answer descriptions of the copies, never a value', async () => {
    const w = await world();
    const listed = await w.call('GET', '/v1/ferrets/:ferretId/copies', { params: { ferretId: SESSION } });
    const none = await w.call('GET', '/v1/ferrets/:ferretId/copies', { params: { ferretId: 'other' } });
    should(listed).match({ status: 200, body: { copies: [{ name: 'token', size: 12 }] } });
    should(none.body).eql({ copies: [] });
  });

  it('should refuse a ferret, and a session name that could not be one', async () => {
    const w = await world();
    const ferret = await w.call('GET', '/v1/ferrets/:ferretId/copies', {
      params: { ferretId: SESSION },
      standing: ferretStanding('F1' as FerretId),
    });
    const bad = await w.call('GET', '/v1/ferrets/:ferretId/copies', { params: { ferretId: '../x' } });
    should(ferret).match({ status: 403, code: OWNER_ONLY_CODE });
    should(ferret.body).containEql('makes or changes a paste rule');
    should(bad).match({ status: 400, code: 'bad_request', body: 'the ferretId in the path is not usable' });
  });
});

describe('the rules', () => {
  it('should list the rules the owner has, and none to a ferret', async () => {
    const w = await world();
    await w.rules.create(HOST, TO_TERMINAL);
    const listed = await w.call('GET', '/v1/copy-rules');
    const ferret = await w.call('GET', '/v1/copy-rules', { standing: ferretStanding('F1' as FerretId) });
    should(listed).match({ status: 200, body: { rules: [{ to: { program: 'vercel' } }] } });
    should(ferret.status).equal(403);
  });

  it('should make nothing at the old one-step create, and say where the passkey is asked', async () => {
    const w = await world();
    const refused = await w.call('POST', '/v1/copy-rules', { body: TO_TERMINAL });
    should(refused).match({ status: 409, code: PASTE_RULE_ERROR_CODES.passkeyNeeded });
    should((await w.call('GET', '/v1/copy-rules')).body).match({ rules: [] });
  });

  it('should take a rule away with no more than the use permission, and find it gone the second time', async () => {
    const w = await world();
    const rule = await w.rules.create(HOST, TO_TERMINAL);
    const removed = await w.call('DELETE', '/v1/copy-rules/:ruleId', { params: { ruleId: rule.id } });
    const again = await w.call('DELETE', '/v1/copy-rules/:ruleId', { params: { ruleId: rule.id } });
    const bad = await w.call('DELETE', '/v1/copy-rules/:ruleId', { params: { ruleId: 'x' } });
    should(removed).match({ status: 200, body: { removed: true } });
    should(again).match({ status: 404, code: 'not_found' });
    should(bad).match({ status: 400, body: 'the ruleId in the path is not usable' });
  });
});

describe('staging and committing a rule', () => {
  const commit = '/v1/copy-rules/stages/:stage/commit';

  it('should stage the daemon’s own line and rows, allowing nothing yet', async () => {
    const w = await world();
    const answer = await w.call('POST', '/v1/copy-rules/stages', { body: TO_TERMINAL, standing: phone() });
    should(answer).match({ status: 201, body: { stage: /^prs_/u, kind: 'rule' } });
    should((await w.call('GET', '/v1/copy-rules')).body).match({ rules: [] });
  });

  it('should refuse a body that is not a rule before it is staged', async () => {
    const w = await world();
    const bad = await w.call('POST', '/v1/copy-rules/stages', { body: { from: GH }, standing: phone() });
    should(bad).match({ status: 400, code: 'invalid_request' });
  });

  it('should demand the secrets permission to stage a paste into the store and the browser permission for a page', async () => {
    const w = await world();
    const store = await w.call('POST', '/v1/copy-rules/stages', { body: TO_STORE, standing: without(['secrets']) });
    const page = await w.call('POST', '/v1/copy-rules/stages', { body: TO_PAGE, standing: without(['browser']) });
    const terminal = await w.call('POST', '/v1/copy-rules/stages', {
      body: TO_TERMINAL,
      standing: without(['secrets', 'browser']),
    });
    should(store).match({ status: 403, code: 'grant_not_granted' });
    should(store.body).match({ error: /approve pastes into the secret store/u });
    should(page).match({ status: 403, code: 'grant_not_granted' });
    should(page.body).match({ error: /approve pastes into a page/u });
    should(terminal.status).equal(201);
    should((await w.call('GET', '/v1/copy-rules/stages', { standing: phone() })).body).match({ stages: [{}] });
  });

  it('should list the stages waiting for the caller, and read one', async () => {
    const w = await world();
    const stage = await staged(w);
    const listed = await w.call('GET', '/v1/copy-rules/stages', { standing: phone() });
    const view = await w.call('GET', stageRoute, { params: { stage }, standing: phone() });
    const strangers = await w.call('GET', '/v1/copy-rules/stages', { standing: allowedDevice({}, 'laptop-2') });
    should(listed).match({ status: 200, body: { stages: [{ stage }] } });
    should(view).match({ status: 200, body: { stage, state: 'waiting' } });
    should(strangers.body).match({ stages: [] });
  });

  it('should call a stage that is not the caller’s, or never minted, not waiting', async () => {
    const w = await world();
    const stage = await staged(w);
    const other = await w.call('GET', stageRoute, { params: { stage }, standing: allowedDevice({}, 'laptop-2') });
    const forged = await w.call('GET', stageRoute, { params: { stage: 'prs_nope' } });
    should(other).match({ status: 404, code: PASTE_RULE_ERROR_CODES.stageNotFound });
    should(forged).match({ status: 400, code: 'bad_request', body: 'the stage in the path is not usable' });
  });

  it('should answer the step-up demand naming the act when no fresh proof is bound to the stage', async () => {
    const w = await world();
    const stage = await staged(w);

    const demanded = await w.call('POST', commit, { params: { stage }, standing: phone() });

    should(demanded).match({
      status: 403,
      code: STEP_UP_REQUIRED_CODE,
      body: { demand: { capability: 'terminal', axis: 'configure', act: 'approve-paste-rule' } },
    });
    should((await w.call('GET', '/v1/copy-rules')).body).match({ rules: [] });
  });

  it('should never let the machine’s own token commit a stage the machine made: it holds no passkey', async () => {
    const w = await world();
    const stage = await staged(w, TO_TERMINAL, machine());
    const refused = await w.call('POST', commit, {
      params: { stage },
      standing: machine({ claimFreshStepUp: (() => true) as CallStanding['claimFreshStepUp'] }),
    });
    should(refused).match({ status: 404, code: PASTE_RULE_ERROR_CODES.stageNotFound });
    should((await w.call('GET', '/v1/copy-rules')).body).match({ rules: [] });
  });

  it('should make the rule with a proof claimed for exactly this stage’s subject, and answer 201', async () => {
    const w = await world();
    const stage = await staged(w);
    const claimed: string[] = [];

    const made = await w.call('POST', commit, { params: { stage }, standing: proving(claimed) });

    should(made).match({ status: 201, body: { to: { program: 'vercel' }, used: 0 } });
    should(claimed).have.length(1);
    should(claimed[0]).startWith('approve-paste-rule:');
    should((await w.call('GET', '/v1/copy-rules')).body).match({ rules: [{}] });
    // Used once: the stage no longer waits.
    should((await w.call('POST', commit, { params: { stage }, standing: proving() })).status).equal(404);
  });

  it('should answer a rule the service refuses at its commit in its own status, and make nothing', async () => {
    const w = await world();
    const stage = await staged(w);
    for (let count = 0; count < COPY_MAX_RULES; count += 1)
      await w.rules.create(HOST, { from: GH, to: { kind: 'terminal', program: `tool${String(count)}` } });

    const full = await w.call('POST', commit, { params: { stage }, standing: proving() });

    should(full).match({ status: 429, code: 'capacity' });
    should((await w.rules.list(HOST)).length).equal(COPY_MAX_RULES);
  });

  it('should spend a governed device’s single-use step-up only when the rule writes into the secret store', async () => {
    const w = await world();
    let spent = 0;
    const spending = () => ({
      ...proving(),
      spendFreshStepUp: () => {
        spent += 1;
      },
    });
    const store = await staged(w, TO_STORE);
    const terminal = await staged(w, TO_TERMINAL);

    should((await w.call('POST', commit, { params: { stage: terminal }, standing: spending() })).status).equal(201);
    should(spent).equal(0);
    should((await w.call('POST', commit, { params: { stage: store }, standing: spending() })).status).equal(201);
    should(spent).equal(1);
  });

  it('should refuse a commit whose destination the device may not reach, claiming no proof', async () => {
    const w = await world();
    const store = await staged(w, TO_STORE);
    const page = await staged(w, TO_PAGE);
    const claimed: string[] = [];

    const noSecrets = await w.call('POST', commit, { params: { stage: store }, standing: without(['secrets']) });
    const noBrowser = await w.call('POST', commit, { params: { stage: page }, standing: without(['browser']) });

    should(noSecrets).match({ status: 403, code: 'grant_not_granted' });
    should(noBrowser).match({ status: 403, code: 'grant_not_granted' });
    should(claimed).eql([]);
    should((await w.call('GET', '/v1/copy-rules')).body).match({ rules: [] });
  });

  it('should find a stage that is gone, or not the caller’s, not waiting', async () => {
    const w = await world();
    const stage = await staged(w);
    const other = await w.call('POST', commit, {
      params: { stage },
      standing: allowedDevice({}, 'laptop-2'),
    });
    await w.call('DELETE', stageRoute, { params: { stage }, standing: phone() });
    const gone = await w.call('POST', commit, { params: { stage }, standing: phone() });
    should(other).match({ status: 404, code: PASTE_RULE_ERROR_CODES.stageNotFound });
    should(gone.status).equal(404);
  });

  it('should drop a stage with no more than the use permission, and then find it gone', async () => {
    const w = await world();
    const stage = await staged(w);
    const dropped = await w.call('DELETE', stageRoute, { params: { stage }, standing: phone() });
    const again = await w.call('DELETE', stageRoute, { params: { stage }, standing: phone() });
    should(dropped).match({ status: 200, body: { stage, dropped: true } });
    should(again.status).equal(404);
  });

  it('should let one device take a stage the machine made, and refuse the machine taking it', async () => {
    const w = await world();
    const stage = await staged(w, TO_TERMINAL, machine());
    const bind = '/v1/copy-rules/stages/:stage/bind';

    const atMachine = await w.call('POST', bind, { params: { stage } });
    const taken = await w.call('POST', bind, { params: { stage }, standing: phone() });
    const other = await w.call('POST', bind, { params: { stage }, standing: allowedDevice({}, 'laptop-2') });

    should(atMachine.status).equal(404);
    should(taken).match({ status: 200, body: { stage } });
    should(other.status).equal(404);
  });
});

describe('the settings', () => {
  const homes: RuleProgramHomes = { profileCouldStandFor: async program => program === 'vercel' };

  it('should read the settings with the rules a program from the profile could satisfy', async () => {
    const w = await world({ homes });
    const vercel = await w.rules.create(HOST, TO_TERMINAL);
    await w.rules.create(HOST, { from: GH, to: { kind: 'terminal', program: 'psql' } });
    await w.rules.create(HOST, TO_PAGE);

    const view = await w.call('GET', '/v1/copy-rules/settings');

    should(view).match({ status: 200, body: { settings: { allowProfileTargets: false }, profileRules: [vercel.id] } });
  });

  it('should mark a rule when the look at the profile fails, since it cannot be ruled out', async () => {
    const w = await world({
      homes: {
        profileCouldStandFor: async () => {
          throw new Error('the profile cannot be read');
        },
      },
    });
    const rule = await w.rules.create(HOST, TO_TERMINAL);
    should((await w.call('GET', '/v1/copy-rules/settings')).body).match({ profileRules: [rule.id] });
  });

  it('should list no profile rules when no profile is known', async () => {
    const w = await world();
    await w.rules.create(HOST, TO_TERMINAL);
    should((await w.call('GET', '/v1/copy-rules/settings')).body).match({ profileRules: [] });
  });

  it('should refuse the one-step write that turns profile targets on, and allow keeping or narrowing it', async () => {
    const w = await world({ homes });
    const on = await w.call('PUT', '/v1/copy-rules/settings', { body: { allowProfileTargets: true } });
    const keep = await w.call('PUT', '/v1/copy-rules/settings', { body: { allowProfileTargets: false } });
    const bad = await w.call('PUT', '/v1/copy-rules/settings', { body: { allowProfileTargets: 'yes' } });
    should(on).match({ status: 409, code: PASTE_RULE_ERROR_CODES.profileTargetsPasskeyNeeded });
    should(keep).match({ status: 200, body: { allowProfileTargets: false } });
    should(bad).match({ status: 400, code: 'invalid_request' });
  });

  it('should turn profile targets on only through a stage and a bound proof, then narrow them with no more than use', async () => {
    const w = await world({ homes });
    await w.rules.create(HOST, TO_TERMINAL);
    const stageSettings = '/v1/copy-rules/settings/stages';
    const commit = '/v1/copy-rules/settings/stages/:stage/commit';

    const staged = await w.call('POST', stageSettings, { standing: phone() });
    const stage = (staged.body as { stage: string }).stage;
    const demanded = await w.call('POST', commit, { params: { stage }, standing: phone() });
    const claimed: string[] = [];
    const settled = await w.call('POST', commit, { params: { stage }, standing: proving(claimed) });

    should(staged).match({ status: 201, body: { kind: 'profile-targets' } });
    should(demanded).match({
      status: 403,
      code: STEP_UP_REQUIRED_CODE,
      body: { demand: { capability: 'terminal', axis: 'configure', act: 'allow-profile-targets' } },
    });
    should(settled).match({ status: 200, body: { allowProfileTargets: true } });
    should(claimed[0]).startWith('allow-profile-targets:');
    should((await w.call('GET', '/v1/copy-rules/settings')).body).match({ settings: { allowProfileTargets: true } });
    // Already on: nothing to approve.
    should(await w.call('POST', stageSettings, { standing: phone() })).match({ status: 409, code: 'conflict' });
    // And off again asks no more than the one-step write.
    should(await w.call('PUT', '/v1/copy-rules/settings', { body: { allowProfileTargets: false } })).match({
      status: 200,
      body: { allowProfileTargets: false },
    });
  });

  it('should find a settings stage that is gone, or whose list of widened rules moved, not waiting', async () => {
    const w = await world({ homes });
    const commit = '/v1/copy-rules/settings/stages/:stage/commit';
    const staged = await w.call('POST', '/v1/copy-rules/settings/stages', { standing: phone() });
    const stage = (staged.body as { stage: string }).stage;
    // A rule the profile could now satisfy appears after the owner looked: what they saw is not what would change.
    await w.rules.create(HOST, TO_TERMINAL);
    const moved = await w.call('POST', commit, { params: { stage }, standing: proving() });
    const forged = await w.call('POST', commit, { params: { stage: 'nope' }, standing: proving() });
    should(moved).match({ status: 404, code: PASTE_RULE_ERROR_CODES.profileTargetsChanged });
    should(forged).match({ status: 400, code: 'bad_request' });
  });
});

describe('the paste plans', () => {
  const approve = '/v1/ferrets/:ferretId/copy-plans/:planId/approve';

  it('should list the task plans waiting with paste lines, as paste plans', async () => {
    const w = await world();
    const mixed = await w.plans.propose(SESSION, { lines: [SIGN_IN_LINE, TERMINAL_PASTE] });
    await w.plans.propose(SESSION, { lines: [SIGN_IN_LINE] });

    const listed = await w.call('GET', '/v1/copy-plans');

    should(listed).match({ status: 200, body: { plans: [{ id: mixed.id }] } });
    should((listed.body as { plans: unknown[] }).plans).have.length(1);
  });

  it('should answer a decline, and tell a tick to use the passkey on the plan’s card, writing nothing', async () => {
    const w = await world();
    const plan = await w.plans.propose(SESSION, { lines: [TERMINAL_PASTE] });
    const params = { ferretId: SESSION, planId: plan.id };

    const tick = await w.call('POST', approve, { params, body: { items: [0] } });
    const decline = await w.call('POST', approve, { params, body: { items: [] } });

    should(tick).match({ status: 409, code: 'needs_passkey' });
    should(decline).match({ status: 200, body: { id: plan.id, state: 'declined' } });
    should(await w.rules.list(HOST)).eql([]);
  });

  it('should demand the browser permission before a tick that reaches a page, and the secrets permission for the store', async () => {
    const w = await world();
    const plan = await w.plans.propose(SESSION, {
      lines: [
        { ...TERMINAL_PASTE, to: { kind: 'browser', origin: 'https://vercel.com' } },
        STORE_PASTE,
        TERMINAL_PASTE,
      ],
    });
    const params = { ferretId: SESSION, planId: plan.id };

    const page = await w.call('POST', approve, { params, body: { items: [0] }, standing: without(['browser']) });
    const store = await w.call('POST', approve, { params, body: { items: [1] }, standing: without(['secrets']) });
    const terminal = await w.call('POST', approve, {
      params,
      body: { items: [2] },
      standing: without(['browser', 'secrets']),
    });

    should(page).match({ status: 403, code: 'grant_not_granted' });
    should(page.body).match({ error: /approve pastes into a page/u });
    should(store).match({ status: 403, code: 'grant_not_granted' });
    should(store.body).match({ error: /approve pastes into the secret store/u });
    // A paste into a terminal reaches neither: the service's own answer, the passkey, not a permission.
    should(terminal).match({ status: 409, code: 'needs_passkey' });
  });

  it('should refuse a ferret before the body is read, and paths that could not name a plan or a session', async () => {
    const w = await world();
    const plan = await w.plans.propose(SESSION, { lines: [TERMINAL_PASTE] });
    const ferret = await w.call('POST', approve, {
      params: { ferretId: SESSION, planId: plan.id },
      raw: 'not json at all',
      standing: ferretStanding('F1' as FerretId),
    });
    const badBody = await w.call('POST', approve, { params: { ferretId: SESSION, planId: plan.id }, raw: '{' });
    const badPlan = await w.call('POST', approve, { params: { ferretId: SESSION, planId: 'x' }, body: { items: [] } });
    const badSession = await w.call('POST', approve, {
      params: { ferretId: '-bad', planId: plan.id },
      body: { items: [] },
    });
    should(ferret).match({ status: 403, code: OWNER_ONLY_CODE });
    should(badBody).match({ status: 400, code: 'invalid_json' });
    should(badPlan).match({ status: 400, body: 'the planId in the path is not usable' });
    should(badSession).match({ status: 400, body: 'the ferretId in the path is not usable' });
  });

  it('should answer a plan that is not held, or an item it does not have, in the service’s words', async () => {
    const w = await world();
    const plan = await w.plans.propose(SESSION, { lines: [TERMINAL_PASTE] });
    const missing = await w.call('POST', approve, {
      params: { ferretId: SESSION, planId: 'c'.repeat(32) },
      body: { items: [0] },
    });
    const noItem = await w.call('POST', approve, {
      params: { ferretId: SESSION, planId: plan.id },
      body: { items: [5] },
    });
    should(missing).match({ status: 404, code: 'not_found' });
    should(noItem).match({ status: 400, code: 'bad_request' });
  });
});
