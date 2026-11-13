import { describe, it } from 'bun:test';
import { STEP_UP_REQUIRED_CODE } from '@ferretry/core-gate/contract';
import { ferretStanding } from '@ferretry/core-gate/contract/testing';
import type { CallStanding, FerretId } from '@ferretry/kernel/contract';
import should from 'should';
import type { TaskPlan } from '../../../../contract/routes/index.ts';
import { SecureCopyError } from '../../../../daemon/lib/secure-copy/errors.ts';
import type { PasteRuleCaller } from '../../../../daemon/lib/secure-copy/rules.ts';
import { taskPlanAnswered, taskPlanRoutes } from '../../../../daemon/lib/runtime/mounts/task-plans.ts';
import { TaskPlanError } from '../../../../daemon/lib/task-plans/service.ts';
import { allowedDevice, driverOf, governedDevice, without as deviceWithout } from './driver.ts';
import {
  HOST,
  PAGE_PASTE,
  PHONE,
  planWorld,
  SESSION,
  SIGN_IN_LINE,
  STORE_PASTE,
  TERMINAL_PASTE,
} from './plan-world.ts';

/** The owner's task-plan routes, driven on the route table with a real TaskPlanService over a real PasteRuleService. */

function world() {
  const built = planWorld();
  return { ...built, call: driverOf(taskPlanRoutes(built.plans)) };
}

const PLAN_ROUTE = '/v1/ferrets/:ferretId/task-plans/:planId';
const at = (_plan: Pick<TaskPlan, 'id'> | object) => PLAN_ROUTE;
const paramsOf = (plan: Pick<TaskPlan, 'id'>, extra: Record<string, string> = {}) => ({
  ferretId: SESSION,
  planId: plan.id,
  ...extra,
});

const without = (...capabilities: string[]) => deviceWithout(capabilities);

describe('GET /v1/accounts/plans', () => {
  it('should list the plans waiting, for one session when asked, and nothing but plans', async () => {
    const w = world();
    await w.rules.load();
    const mine = await w.plans.propose(SESSION, { lines: [TERMINAL_PASTE] });
    await w.plans.propose('s2', { lines: [TERMINAL_PASTE] });

    const all = await w.call('GET', '/v1/accounts/plans');
    const filtered = await w.call('GET', '/v1/accounts/plans', { query: { session: SESSION } });

    should(all.status).equal(200);
    should((all.body as { plans: unknown[] }).plans).have.length(2);
    should((filtered.body as { plans: { id: string }[] }).plans.map(plan => plan.id)).eql([mine.id]);
  });

  it('should refuse a session name no ferret could have, before listing anything', async () => {
    const w = world();
    const refused = await w.call('GET', '/v1/accounts/plans', { query: { session: '../secrets' } });
    should(refused).match({ status: 400, code: 'bad_request' });
  });

  it('should refuse a device denied the accounts, and a caller the daemon cannot judge', async () => {
    const w = world();
    const denied = await w.call('GET', '/v1/accounts/plans', { standing: without('secrets') });
    should(denied).match({ status: 403, code: 'grant_not_granted' });
    const unjudged = await w.call('GET', '/v1/accounts/plans', { standing: ferretStanding('F1' as FerretId) });
    should(unjudged).match({ status: 403, code: 'forbidden' });
  });
});

describe('reading one plan', () => {
  it('should answer the plan to the owner and to a device allowed the accounts', async () => {
    const w = world();
    await w.rules.load();
    const plan = await w.plans.propose(SESSION, { lines: [SIGN_IN_LINE] });

    const owner = await w.call('GET', at(plan), { params: paramsOf(plan) });
    const device = await w.call('GET', at(plan), { params: paramsOf(plan), standing: allowedDevice() });

    should(owner).match({ status: 200, body: { id: plan.id, state: 'pending' } });
    should(device.status).equal(200);
  });

  it('should refuse a ferret before anything else, in the owner-only words', async () => {
    const w = world();
    const refused = await w.call('GET', at({ id: 'b'.repeat(32) } as TaskPlan), {
      params: { ferretId: SESSION, planId: 'b'.repeat(32) },
      standing: ferretStanding('F1' as FerretId),
    });
    should(refused).match({ status: 403, code: 'owner_only' });
    should(refused.body).containEql('approves or changes a task plan');
  });

  it('should refuse a path that could not name a plan or a session, and a plan that is not held', async () => {
    const w = world();
    const badPlan = await w.call('GET', at({} as TaskPlan), { params: { ferretId: SESSION, planId: 'nope' } });
    should(badPlan).match({ status: 400, code: 'bad_request' });
    should(badPlan.body).equal('the planId in the path is not usable');
    const badSession = await w.call('GET', at({} as TaskPlan), {
      params: { ferretId: '-bad', planId: 'b'.repeat(32) },
    });
    should(badSession.body).equal('the ferretId in the path is not usable');
    const missing = await w.call('GET', at({} as TaskPlan), {
      params: { ferretId: SESSION, planId: 'b'.repeat(32) },
    });
    should(missing.status).equal(404);
  });

  it('should refuse a device denied the accounts the plan that names them', async () => {
    const w = world();
    await w.rules.load();
    const plan = await w.plans.propose(SESSION, { lines: [SIGN_IN_LINE] });
    const denied = await w.call('GET', at(plan), { params: paramsOf(plan), standing: without('secrets') });
    should(denied).match({ status: 403, code: 'grant_not_granted' });
  });
});

describe('staging an approval', () => {
  const route = '/v1/ferrets/:ferretId/task-plans/:planId/approval';

  it('should answer a decline at once, with nothing held for a passkey', async () => {
    const w = world();
    await w.rules.load();
    const plan = await w.plans.propose(SESSION, { lines: [TERMINAL_PASTE] });

    const declined = await w.call('POST', route, { params: paramsOf(plan), body: { lines: [] } });

    should(declined).match({ status: 200, body: { outcome: 'answered', plan: { state: 'declined' } } });
  });

  it('should hold any ticked line for its passkey, and answer 201 with the stage', async () => {
    const w = world();
    await w.rules.load();
    const plan = await w.plans.propose(SESSION, { lines: [SIGN_IN_LINE, TERMINAL_PASTE] });

    const held = await w.call('POST', route, { params: paramsOf(plan), body: { lines: [{ line: 1 }] } });

    should(held).match({ status: 201, body: { outcome: 'staged', staged: { stage: /^tps_/u } } });
  });

  it('should refuse a body that is not an approval before touching the plan', async () => {
    const w = world();
    await w.rules.load();
    const plan = await w.plans.propose(SESSION, { lines: [TERMINAL_PASTE] });
    const refused = await w.call('POST', route, { params: paramsOf(plan), body: { lines: 'all' } });
    should(refused).match({ status: 400, code: 'invalid_request' });
  });

  it('should demand the browser permission for a sign-in or a paste into a page, whatever else is ticked', async () => {
    const w = world();
    await w.rules.load();
    const plan = await w.plans.propose(SESSION, { lines: [SIGN_IN_LINE, PAGE_PASTE, TERMINAL_PASTE] });
    const standing = without('browser');

    for (const line of [0, 1]) {
      const refused = await w.call('POST', route, {
        params: paramsOf(plan),
        body: { lines: [{ line }] },
        standing,
      });
      should(refused).match({ status: 403, code: 'grant_not_granted' });
      should(refused.body).match({ error: /sign-ins and pastes into a page/u });
    }
    // A paste into a terminal reaches neither a page nor the store: the same device may tick it.
    const terminal = await w.call('POST', route, { params: paramsOf(plan), body: { lines: [{ line: 2 }] }, standing });
    should(terminal.status).equal(201);
  });

  it('should demand the secrets permission for a paste into the secret store', async () => {
    const w = world();
    await w.rules.load();
    const plan = await w.plans.propose(SESSION, { lines: [STORE_PASTE] });
    const refused = await w.call('POST', route, {
      params: paramsOf(plan),
      body: { lines: [{ line: 0 }] },
      standing: without('secrets'),
    });
    should(refused).match({ status: 403, code: 'grant_not_granted' });
    should(refused.body).match({ error: /approve pastes into the secret store/u });
  });

  it('should demand a passkey of a device whose grant needs a step-up for the page', async () => {
    const w = world();
    await w.rules.load();
    const plan = await w.plans.propose(SESSION, { lines: [SIGN_IN_LINE] });
    const refused = await w.call('POST', route, {
      params: paramsOf(plan),
      body: { lines: [{ line: 0 }] },
      standing: governedDevice({ allowed: false, refusal: 'step-up-required' }),
    });
    should(refused).match({ status: 403, code: STEP_UP_REQUIRED_CODE });
  });

  it('should leave a line the plan does not have to the service’s own refusal', async () => {
    const w = world();
    await w.rules.load();
    const plan = await w.plans.propose(SESSION, { lines: [TERMINAL_PASTE] });
    const refused = await w.call('POST', route, { params: paramsOf(plan), body: { lines: [{ line: 5 }] } });
    should(refused.status).be.within(400, 499);
    should(refused.code).be.a.String();
  });
});

describe('a staged selection', () => {
  const stageRoute = '/v1/ferrets/:ferretId/task-plans/:planId/approval/:stage';

  async function staged(
    w: ReturnType<typeof world>,
    lines: readonly unknown[] = [SIGN_IN_LINE],
    actor: PasteRuleCaller & { kind: 'owner' } = HOST,
  ) {
    await w.rules.load();
    const plan = await w.plans.propose(SESSION, { lines });
    const answer = await w.plans.stage(actor, SESSION, plan.id, { lines: [{ line: 0 }] });
    if (answer.outcome !== 'staged') throw new Error('expected a staged selection');
    return { plan, stage: answer.staged.stage };
  }

  it('should read where it stands, and refuse a stage this daemon could never have minted as not waiting', async () => {
    const w = world();
    const { plan, stage } = await staged(w);

    const view = await w.call('GET', stageRoute, { params: paramsOf(plan, { stage }) });
    const forged = await w.call('GET', stageRoute, { params: paramsOf(plan, { stage: 'tps_nope' }) });
    const unknown = await w.call('GET', stageRoute, {
      params: paramsOf(plan, { stage: `tps_${'f'.repeat(24)}` }),
    });

    should(view).match({ status: 200, body: { state: 'waiting' } });
    should(forged).match({ status: 404, code: 'stage_not_found' });
    should(forged.body).equal('that task plan selection is not waiting for a passkey');
    should(unknown).match({ status: 404, code: 'stage_not_found' });
  });

  it('should refuse a device denied the accounts the summary of a stage', async () => {
    const w = world();
    const { plan, stage } = await staged(w);
    const denied = await w.call('GET', stageRoute, {
      params: paramsOf(plan, { stage }),
      standing: without('secrets'),
    });
    should(denied).match({ status: 403, code: 'grant_not_granted' });
  });

  it('should drop a stage with no passkey, and then find it gone', async () => {
    const w = world();
    const { plan, stage } = await staged(w);

    const dropped = await w.call('DELETE', stageRoute, { params: paramsOf(plan, { stage }) });
    const again = await w.call('DELETE', stageRoute, { params: paramsOf(plan, { stage }) });

    should(dropped).match({ status: 200, body: { stage, dropped: true } });
    should(again).match({ status: 404 });
  });

  it('should show a stage the machine made on the plan’s card, and only a stage the machine made', async () => {
    const w = world();
    const { plan, stage } = await staged(w);
    const confirm = '/v1/ferrets/:ferretId/task-plans/:planId/approval/:stage/confirm-in-app';

    const confirmed = await w.call('POST', confirm, { params: paramsOf(plan, { stage }) });

    should(confirmed).match({ status: 201, body: { stage, plan: plan.id } });
    should((await w.plans.get({ kind: 'owner', actor: { kind: 'host' } }, SESSION, plan.id)).machineStage).match({
      stage,
    });
    // A stage a paired device made is that device's own: the machine cannot show it as its own.
    const phone = await w.plans.stage(
      { kind: 'owner', actor: { kind: 'device', deviceId: 'phone-1' } },
      SESSION,
      plan.id,
      {
        lines: [{ line: 0 }],
      },
    );
    if (phone.outcome !== 'staged') throw new Error('expected a staged selection');
    const refused = await w.call('POST', confirm, {
      params: paramsOf(plan, { stage: phone.staged.stage }),
      standing: allowedDevice(),
    });
    should(refused).match({ status: 404, code: 'stage_not_found' });
  });

  describe('its commit', () => {
    const commit = '/v1/ferrets/:ferretId/task-plans/:planId/approval/:stage/commit';

    it('should answer the step-up demand naming the act when no proof is bound, the machine’s token included', async () => {
      const w = world();
      const { plan, stage } = await staged(w);

      const demanded = await w.call('POST', commit, { params: paramsOf(plan, { stage }) });

      should(demanded).match({
        status: 403,
        code: STEP_UP_REQUIRED_CODE,
        body: { demand: { capability: 'terminal', axis: 'configure', act: 'approve-task-plan' } },
      });
      should(w.plans.get({ kind: 'owner', actor: { kind: 'host' } }, SESSION, plan.id).state).equal('pending');
    });

    it('should settle the plan with the proof bound to this stage, claiming it for exactly that subject', async () => {
      const w = world();
      const { plan, stage } = await staged(w, [SIGN_IN_LINE], PHONE);
      const subject = w.plans.boundSubjectOf(stage);
      const claimed: string[] = [];

      const settled = await w.call('POST', commit, {
        params: paramsOf(plan, { stage }),
        standing: allowedDevice({
          claimFreshStepUp: ((act: string, given: string) => {
            claimed.push(`${act}:${given}`);
            return given === subject;
          }) as CallStanding['claimFreshStepUp'],
        }),
      });

      should(settled).match({ status: 200, body: { id: plan.id, state: 'approved' } });
      should(claimed).eql([`approve-task-plan:${subject}`]);
    });

    it('should spend a governed device’s single-use step-up when the commit wrote into the secret store', async () => {
      const w = world();
      await w.rules.load();
      const plan = await w.plans.propose(SESSION, { lines: [STORE_PASTE] });
      const answer = await w.plans.stage({ kind: 'owner', actor: { kind: 'host' } }, SESSION, plan.id, {
        lines: [{ line: 0 }],
      });
      if (answer.outcome !== 'staged') throw new Error('expected a staged selection');
      const stage = answer.staged.stage;
      let spent = 0;

      const settled = await w.call('POST', commit, {
        params: paramsOf(plan, { stage }),
        standing: {
          ...allowedDevice({ claimFreshStepUp: (() => true) as CallStanding['claimFreshStepUp'] }),
          spendFreshStepUp: () => {
            spent += 1;
          },
        },
      });

      should(settled.status).equal(200);
      should(spent).equal(1);
    });

    it('should refuse before any proof is claimed when the device may not reach what is ticked', async () => {
      const w = world();
      const { plan, stage } = await staged(w);
      let claimed = 0;

      const refused = await w.call('POST', commit, {
        params: paramsOf(plan, { stage }),
        standing: {
          ...without('browser'),
          claimFreshStepUp: (() => {
            claimed += 1;
            return true;
          }) as CallStanding['claimFreshStepUp'],
        },
      });

      should(refused).match({ status: 403, code: 'grant_not_granted' });
      should(claimed).equal(0);
    });

    it('should find a stage that is gone, and a stage name that could not be minted, not waiting', async () => {
      const w = world();
      const { plan, stage } = await staged(w);
      await w.call('DELETE', stageRoute, { params: paramsOf(plan, { stage }) });

      const gone = await w.call('POST', commit, { params: paramsOf(plan, { stage }) });
      const forged = await w.call('POST', commit, { params: paramsOf(plan, { stage: 'nope' }) });

      should(gone.status).equal(404);
      should(forged).match({ status: 404, code: 'stage_not_found' });
    });
  });
});

describe('revoking a plan', () => {
  const revoke = '/v1/ferrets/:ferretId/task-plans/:planId/revoke';

  it('should end a plan still waiting whole, with no passkey', async () => {
    const w = world();
    await w.rules.load();
    const plan = await w.plans.propose(SESSION, { lines: [TERMINAL_PASTE] });

    const ended = await w.call('POST', revoke, { params: paramsOf(plan), body: {} });

    should(ended).match({ status: 200, body: { id: plan.id, state: 'revoked' } });
  });

  it('should read the lines to end from the body, and refuse a body that names none twice', async () => {
    const w = world();
    await w.rules.load();
    const plan = await w.plans.propose(SESSION, { lines: [TERMINAL_PASTE] });

    const twice = await w.call('POST', revoke, { params: paramsOf(plan), body: { lines: [0, 0] } });
    const waiting = await w.call('POST', revoke, { params: paramsOf(plan), body: { lines: [0] } });

    should(twice).match({ status: 400, code: 'invalid_request' });
    should(waiting).match({ status: 400, code: 'bad_request' });
  });

  it('should refuse a device denied the accounts, and answer a plan already ended as a conflict', async () => {
    const w = world();
    await w.rules.load();
    const plan = await w.plans.propose(SESSION, { lines: [TERMINAL_PASTE] });

    const denied = await w.call('POST', revoke, { params: paramsOf(plan), body: {}, standing: without('secrets') });
    await w.call('POST', revoke, { params: paramsOf(plan), body: {} });
    const again = await w.call('POST', revoke, { params: paramsOf(plan), body: {} });

    should(denied).match({ status: 403, code: 'grant_not_granted' });
    should(again).match({ status: 409, code: 'conflict' });
  });
});

describe('taskPlanAnswered', () => {
  it('should word each service refusal with its own status and code', () => {
    const caught = (error: unknown) => {
      try {
        taskPlanAnswered(error);
      } catch (thrown) {
        return thrown as { status: number; code: string; message: string };
      }
      throw new Error('expected a refusal');
    };
    const cases = [
      ['bad_request', 400],
      ['not_found', 404],
      ['conflict', 409],
      ['forbidden', 403],
      ['capacity', 429],
      ['unavailable', 503],
      ['upstream_failed', 502],
    ] as const;
    for (const [code, status] of cases)
      should(caught(new SecureCopyError(code, 'a sentence'))).match({ status, code, message: 'a sentence' });
    should(caught(new TaskPlanError(409, 'needs_passkey', 'tick it in the app'))).match({
      status: 409,
      code: 'needs_passkey',
      message: 'tick it in the app',
    });
  });

  it('should rethrow anything that is not a refusal of the service, unchanged', () => {
    const failure = new TypeError('a bug, not a refusal');
    should(() => taskPlanAnswered(failure)).throw(failure);
  });
});
