import { describe, it } from 'bun:test';
import type {
  TaskPlan,
  TaskPlanApproval,
  TaskPlanApprovalAnswer,
  TaskPlanLine,
  TaskPlanStageState,
} from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import should from 'should';
import { COPY_FERRET_REFUSAL } from '../../../src/lib/plan/controller';
import { PlanController } from '../../../src/lib/plan/plan-controller';
import type { IPlanGateway, PlanPorts } from '../../../src/lib/plan/ports';

const STAGE = `tps_${'a'.repeat(24)}`;
const WORK = `si_${'1'.repeat(16)}`;
const HOME = `si_${'2'.repeat(16)}`;
const ONLY = `si_${'3'.repeat(16)}`;

const candidate = (signIn: string, id: string, totp: boolean) => ({
  signIn,
  account: { id, label: id.toLowerCase() },
  username: 'kirin',
  place: { kind: 'site', domains: ['github.com'], match: [] },
  can: { username: true, password: true, totp },
  history: true,
});

const PASTE: TaskPlanLine = {
  kind: 'paste',
  line: 0,
  uses: 1,
  why: 'the deploy token',
  state: 'waiting',
  from: { kind: 'command', program: 'gh' },
  to: { kind: 'terminal', program: 'vercel' },
};
const PICKER: TaskPlanLine = {
  kind: 'sign-in',
  line: 1,
  uses: 1,
  why: 'check the Actions settings',
  state: 'waiting',
  fields: ['username', 'password', 'totp'],
  candidates: [candidate(WORK, 'GITHUB_WORK', true), candidate(HOME, 'GITHUB_HOME', false)],
  flags: [],
} as TaskPlanLine;
const SINGLE: TaskPlanLine = {
  kind: 'sign-in',
  line: 2,
  uses: 1,
  why: 'open the billing page',
  state: 'waiting',
  fields: ['password'],
  candidates: [candidate(ONLY, 'STRIPE', false)],
  flags: [],
} as TaskPlanLine;

const PLAN: TaskPlan = {
  v: 1,
  id: 'feedbeef'.padEnd(32, '0'),
  sessionId: 's1',
  agendaItemId: 'A9',
  lines: [PASTE, PICKER, SINGLE],
  state: 'pending',
  raisedAt: '2026-11-01T12:00:00.000Z',
  expiresAt: '2026-11-01T14:00:00.000Z',
};

/** Every call the CLI makes, by name: a commit would show up here, and the type has no such method. */
class SpyGateway implements IPlanGateway {
  readonly calls: string[] = [];
  readonly staged: TaskPlanApproval[] = [];
  readonly revoked: { readonly planId: string; readonly lines: readonly number[] | undefined }[] = [];
  plan: TaskPlan = PLAN;
  views: (TaskPlanStageState | 'gone')[] = ['waiting', 'approved'];

  async plans() {
    this.calls.push('plans');
    return { plans: [this.plan] };
  }
  async stage(_sessionId: string, _planId: string, approval: TaskPlanApproval): Promise<TaskPlanApprovalAnswer> {
    this.calls.push('stage');
    this.staged.push(approval);
    if (approval.lines.every(tick => this.plan.lines[tick.line]?.kind === 'paste'))
      return {
        outcome: 'answered',
        plan: { ...this.plan, state: approval.lines.length === 0 ? 'declined' : 'approved' },
      };
    return {
      outcome: 'staged',
      staged: {
        stage: STAGE,
        plan: this.plan.id,
        lines: approval.lines.map(tick => tick.line),
        summary: ['Sign in as GITHUB_WORK on github.com'],
        expiresAt: '2026-11-01T12:02:00.000Z',
      },
    };
  }
  async confirmInApp() {
    this.calls.push('confirmInApp');
    return { stage: STAGE, plan: this.plan.id, agendaItemId: 'A9' };
  }
  async view() {
    this.calls.push('view');
    const state = this.views.shift() ?? 'waiting';
    if (state === 'gone') throw new FyHttpError('gone', 404, 'stage_not_found');
    return {
      stage: STAGE,
      plan: this.plan.id,
      lines: [1],
      summary: ['Sign in'],
      expiresAt: '2026-11-01T12:02:00.000Z',
      state,
    };
  }
  async revoke(_sessionId: string, planId: string, lines?: readonly number[]) {
    this.calls.push('revoke');
    this.revoked.push({ planId, lines });
    return { ...this.plan, state: 'revoked' as const };
  }
}

function rig(overrides: Partial<PlanPorts> = {}) {
  const gateway = new SpyGateway();
  const said: string[] = [];
  const warned: string[] = [];
  const opened: string[] = [];
  let now = 0;
  const slept: number[] = [];
  const controller = new PlanController({
    gateway,
    out: { success: message => void said.push(message), diagnostic: message => void warned.push(message) },
    ownSessionId: undefined,
    agentCredential: undefined,
    cardLink: id => `https://app.test/#agenda/${id}`,
    open: async url => {
      opened.push(url);
      return true;
    },
    sleep: async ms => {
      slept.push(ms);
      now += ms;
    },
    nowMs: () => now,
    ...overrides,
  });
  return { gateway, said, warned, opened, slept, controller };
}

const failure = async (work: Promise<unknown>): Promise<string> =>
  await work.then(
    () => 'no error',
    (error: Error) => error.message,
  );

describe('fy plan: who may run it', () => {
  it('should refuse every command inside a ferret pane or with an agent credential, before any daemon call', async () => {
    const inPane = rig({ ownSessionId: 's1' });
    const withCredential = rig({ agentCredential: 'cap' });

    const refusals = await Promise.all([
      failure(inPane.controller.list({})),
      failure(inPane.controller.approve('feed', ['1'], {})),
      failure(withCredential.controller.approve('feed', ['2'], { pick: ['2=GITHUB_WORK'] })),
      failure(withCredential.controller.revoke('feed', [], {})),
    ]);

    should(new Set(refusals)).eql(new Set([COPY_FERRET_REFUSAL]));
    should([inPane.gateway.calls, withCredential.gateway.calls]).eql([[], []]);
  });
});

describe('fy plan approve: a sign-in line is never approved without the app', () => {
  it('should answer a paste-only selection at once, with no stage in the app', async () => {
    const { controller, gateway, said, opened } = rig();

    await controller.approve('feed', ['1'], {});

    should(gateway.staged).eql([{ lines: [{ line: 0 }] }]);
    should(gateway.calls).eql(['plans', 'stage']);
    should(said).eql([
      'Allowed line 1 of the plan feedbeef: each goes through for the uses it asked, until 2026-11-01T14:00:00.000Z.',
    ]);
    should(opened).eql([]);
  });

  it('should stage a sign-in line, confirm it in the app, print the card link and poll until approved', async () => {
    const { controller, gateway, said, slept } = rig();

    await controller.approve('feed', ['3'], {});

    should(gateway.staged).eql([{ lines: [{ line: 2, signIn: ONLY }] }]);
    should(gateway.calls).eql(['plans', 'stage', 'confirmInApp', 'view', 'view']);
    should(slept).eql([1_000]);
    should(said[0]).equal('  Sign in as GITHUB_WORK on github.com');
    should(said[1]).containEql('https://app.test/#agenda/A9');
    should(said[1]).containEql('Nothing is approved until you do');
    should(said[2]).startWith('Approved.');
  });

  it('should never call anything that commits: the gateway the CLI holds has no such method', async () => {
    const { controller, gateway } = rig();
    gateway.views = ['approved'];

    await controller.approve('feed', ['1', '2', '3'], { pick: ['2=GITHUB_WORK'], totp: ['2'] });

    should(gateway.calls.filter(call => /commit|approve/iu.test(call))).eql([]);
    should(Object.getOwnPropertyNames(SpyGateway.prototype).filter(name => /commit/iu.test(name))).eql([]);
  });

  it('should open the card when asked, and say so when no browser could open', async () => {
    const opening = rig();
    await opening.controller.approve('feed', ['3'], { open: true });
    const failing = rig({ open: async () => false });
    await failing.controller.approve('feed', ['3'], { open: true });

    should(opening.opened).eql(['https://app.test/#agenda/A9']);
    should(failing.warned).eql(['could not open a browser; open https://app.test/#agenda/A9 yourself']);
  });

  it('should say Denied, and Timed out for a stage that is gone, and stop polling at the deadline', async () => {
    const denied = rig();
    denied.gateway.views = ['denied'];
    await denied.controller.approve('feed', ['3'], {});
    const gone = rig();
    gone.gateway.views = ['waiting', 'gone'];
    await gone.controller.approve('feed', ['3'], {});
    const silent = rig();
    silent.gateway.views = Array.from({ length: 400 }, () => 'waiting' as const);
    await silent.controller.approve('feed', ['3'], {});

    should(denied.said.at(-1)).startWith('Denied.');
    should(gone.said.at(-1)).startWith('Timed out.');
    should(silent.said.at(-1)).startWith('Timed out.');
    should(silent.slept.length).be.within(120, 126);
  });
});

describe('fy plan approve: what is checked before anything is staged', () => {
  it('should stage nothing for a --pick outside the line’s accounts', async () => {
    const { controller, gateway } = rig();

    const message = await failure(controller.approve('feed', ['2'], { pick: ['2=SOMEONE_ELSE'] }));

    should(message).containEql('"SOMEONE_ELSE" is not one of its accounts (GITHUB_WORK, GITHUB_HOME)');
    should(gateway.staged).eql([]);
    should(gateway.calls).eql(['plans']);
  });

  it('should stage nothing for a --pick of a sign-in id the line does not list', async () => {
    const { controller, gateway } = rig();

    const message = await failure(controller.approve('feed', ['2'], { pick: [`2=si_${'f'.repeat(16)}`] }));

    should(message).containEql('is not one of its accounts');
    should(gateway.staged).eql([]);
  });

  it('should take a pick by account handle or by si_… id, and a code tick only where it can work', async () => {
    const byHandle = rig();
    byHandle.gateway.views = ['approved'];
    await byHandle.controller.approve('feed', ['2'], { pick: ['2=GITHUB_WORK'], totp: ['2'] });
    const byId = rig();
    byId.gateway.views = ['approved'];
    await byId.controller.approve('feed', ['2'], { pick: [`2=${HOME}`] });

    should(byHandle.gateway.staged).eql([{ lines: [{ line: 1, signIn: WORK, totp: true }] }]);
    should(byId.gateway.staged).eql([{ lines: [{ line: 1, signIn: HOME }] }]);
    const noCodes = rig();
    should(await failure(noCodes.controller.approve('feed', ['2'], { pick: [`2=${HOME}`], totp: ['2'] }))).containEql(
      'GITHUB_HOME has no automatic codes',
    );
    should(noCodes.gateway.staged).eql([]);
  });

  it('should ask for a pick on a line with several accounts, and refuse a pick or code on a paste', async () => {
    const { controller, gateway } = rig();

    const several = await failure(controller.approve('feed', ['2'], {}));
    const onPaste = await failure(controller.approve('feed', ['1'], { pick: ['1=GITHUB_WORK'] }));
    const codeOnPaste = await failure(controller.approve('feed', ['1'], { totp: ['1'] }));

    should(several).containEql('more than one account');
    should(several).containEql('--pick 2=<account or si_…>');
    should(onPaste).containEql('is a paste');
    should(codeOnPaste).containEql('is a paste');
    should(gateway.staged).eql([]);
  });

  it('should refuse a line that is not in the plan, a pick for a line not listed, and a plan that is not waiting', async () => {
    const { controller, gateway } = rig();

    const missing = await failure(controller.approve('feed', ['4'], {}));
    const unlisted = await failure(controller.approve('feed', ['1'], { pick: ['2=GITHUB_WORK'] }));
    gateway.plan = { ...PLAN, state: 'approved' };
    const answered = await failure(controller.approve('feed', ['1'], {}));

    should(missing).containEql('lines 1 to 3');
    should(unlisted).containEql('which you did not list to allow');
    should(answered).containEql('is approved, not waiting');
    should(gateway.staged).eql([]);
  });

  it('should refuse a line that cannot be ticked any more', async () => {
    const { controller, gateway } = rig();
    gateway.plan = { ...PLAN, lines: [{ ...PASTE, state: 'declined' }, PICKER, SINGLE] };

    should(await failure(controller.approve('feed', ['1'], {}))).containEql("can't be allowed: it is declined");
    should(gateway.staged).eql([]);
  });

  it('should decline the plan when no line is named', async () => {
    const { controller, gateway, said } = rig();

    await controller.approve('feed', [], {});

    should(gateway.staged).eql([{ lines: [] }]);
    should(said).eql(['Declined the plan feedbeef.']);
  });

  it('should ask for the plan by its id, and by enough of it', async () => {
    const { controller } = rig();

    should(await failure(controller.approve(' ', [], {}))).equal('name the plan by its id (see `plan ls`)');
    should(await failure(controller.approve('zzz', [], {}))).equal('no plan starts with "zzz"');
  });
});

describe('fy plan ls and revoke', () => {
  it('should list each line in the owner’s words, with the ferret’s reason shown as text', async () => {
    const { controller, gateway, said } = rig();
    gateway.plan = { ...PLAN, lines: [{ ...PASTE, why: 'a‮b' }, PICKER, SINGLE] };

    await controller.list({});

    should(said[0]).startWith('feedbeef  !A9  pending  session s1  until 2026-11-01T14:00:00.000Z');
    should(said[0]).containEql('1. [waiting] paste command:gh → terminal:vercel  the agent says: a\\u{202e}b');
    should(said[0]).containEql(
      '2. [waiting] sign in on a page: username, password, totp — GITHUB_WORK (github_work) at github.com, can make codes; GITHUB_HOME (github_home) at github.com',
    );
  });

  it('should print the protocol payload with --json, and say plainly when no plan is waiting', async () => {
    const { controller, gateway, said } = rig();
    await controller.list({ json: true });
    gateway.plan = PLAN;
    gateway.plans = async () => ({ plans: [] });
    await controller.list({});

    should(Object.keys(JSON.parse(said[0] as string) as object)).eql(['plans']);
    should(said[1]).equal('no plans are waiting');
  });

  it('should revoke the named lines, or every line when none is named', async () => {
    const { controller, gateway, said } = rig();

    await controller.revoke('feed', ['2', '3', '2'], {});
    await controller.revoke('feed', [], {});

    should(gateway.revoked).eql([
      { planId: PLAN.id, lines: [1, 2] },
      { planId: PLAN.id, lines: undefined },
    ]);
    should(said).eql(['Revoked line 2, 3 of the plan feedbeef.', 'Revoked the plan feedbeef: every line is ended.']);
    should(await failure(controller.revoke('feed', ['9'], {}))).containEql('lines 1 to 3');
  });
});
