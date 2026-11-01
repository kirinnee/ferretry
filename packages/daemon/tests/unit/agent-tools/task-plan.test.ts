import { describe, it } from 'bun:test';
import {
  type AccountId,
  type AccountKey,
  type AccountSummary,
  type SignInSummary,
  AgentToolCallSchema,
  type AgentToolCall,
  CopyPlanSchema,
  TaskPlanAgentViewSchema,
  type TaskPlanCall,
  TASK_PLAN_MAX_PENDING_PER_SESSION,
} from '@ferretry/protocol';
import should from 'should';
import { type AgentToolError, PasteRuleService, TaskPlanService, type TaskPlanCard } from '../../../src/lib/index.ts';
import { agent, agentToolWorld, person } from './support.ts';

const work = (id: string): AccountId => id as AccountId;

const NOW = Date.parse('2026-11-01T12:00:00.000Z');

const GH = { kind: 'command', program: 'gh' } as const;
const PASTE_LINE = {
  kind: 'paste',
  from: GH,
  to: { kind: 'terminal', program: 'vercel' },
  uses: 1,
  why: 'the deploy token',
} as const;
const SITE_LINE = {
  kind: 'sign-in',
  site: 'github.com',
  fields: ['username', 'password', 'totp'] as ('username' | 'password' | 'totp')[],
  uses: 1,
  why: 'check the Actions settings',
} as const;
const OLD_ITEMS = [{ from: GH, to: { kind: 'terminal', program: 'vercel' }, why: 'the deploy token' }] as const;

const refused = async (work: Promise<unknown>): Promise<AgentToolError> =>
  (await work.then(
    () => {
      throw new Error('expected a refusal');
    },
    (error: unknown) => error,
  )) as AgentToolError;

const KEY: AccountKey = `L${'A'.repeat(24)}`;
const EMPTY = { accounts: [] as AccountSummary[], signIns: [] as SignInSummary[] };

/** One saved github.com sign-in; the secret fields it holds (a username, a TOTP key) are what must never reach a ferret. */
function githubWith(options: { readonly totp: boolean }) {
  const id = work(options.totp ? 'GITHUB_WORK' : 'GITHUB_HOME');
  return {
    accounts: [
      {
        id,
        label: options.totp ? 'GitHub secret-label-work' : 'GitHub secret-label-home',
        username: options.totp ? 'secret-user-work' : 'secret-user-home',
        fields: { password: true, totp: options.totp },
        factors: [],
        signIns: [],
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
      } as AccountSummary,
    ],
    signIns: [
      {
        id: options.totp ? 'si_00000000000000a1' : 'si_00000000000000a2',
        account: id,
        place: { kind: 'site', domains: ['github.com'], match: [] },
        method: { kind: 'password' },
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
      } as SignInSummary,
    ],
  };
}

/** The real plan service over an empty account store: a site line is "not in Accounts" and stays unavailable. */
function planWorld(accounts: { readonly accounts: AccountSummary[]; readonly signIns: SignInSummary[] } = EMPTY) {
  const cards: (TaskPlanCard & { readonly sessionId: string })[] = [];
  const proposed: { readonly sessionId: string; readonly call: TaskPlanCall }[] = [];
  const rules = new PasteRuleService({
    store: { read: async () => undefined, write: async () => undefined },
    clock: { now: () => NOW },
    ids: { ruleId: () => 'c'.repeat(32) },
    warn: () => undefined,
  });
  let issued = 0;
  const plans = new TaskPlanService({
    agenda: {
      raise: async (sessionId, card) => {
        cards.push({ ...card, sessionId });
        return { ok: true, id: `A${String(cards.length)}` };
      },
      close: async () => undefined,
    },
    rules,
    accounts: {
      listing: async () => accounts,
      keyOf: async id => (accounts.accounts.some(each => each.id === id) ? KEY : undefined),
    },
    passkeys: { any: async () => true },
    redact: async text => text,
    tell: async () => undefined,
    audit: { record: async () => undefined },
    clock: { now: () => NOW },
    ids: { planId: () => (++issued).toString(16).padStart(32, 'b') },
  });
  const world = agentToolWorld({
    plans: {
      propose: async (sessionId, call) => {
        proposed.push({ sessionId, call });
        return await plans.propose(sessionId, call);
      },
    },
  });
  return { ...world, cards, proposed };
}

/** The same wish asked under either name: the new tool, and the old one's body. */
const BOTH_NAMES: readonly { readonly name: string; readonly call: AgentToolCall }[] = [
  { name: 'task.plan', call: { tool: 'task.plan', lines: [PASTE_LINE] } },
  { name: 'secure.preapprove', call: { tool: 'secure.preapprove', items: [...OLD_ITEMS] } },
];

describe('the task.plan agent tool', () => {
  it('should raise one card for the lines and say plainly that nothing is filled from it yet', async () => {
    const world = planWorld();

    const answered = await world.service.call(agent, { tool: 'task.plan', lines: [PASTE_LINE, SITE_LINE] });

    should(answered.summary).equal(
      'Asked the owner to approve 2 lines in advance (!A1). ' +
        'The plan is only recorded for now: Ferretry fills nothing from it yet, so keep raising ' +
        'browser_request_input / terminal_request_input and the owner is asked each time.',
    );
    should(world.cards).have.length(1);
    should(world.cards[0]?.sessionId).equal('s1');
    const view = TaskPlanAgentViewSchema.parse(answered.taskPlan);
    should(view.lines.map(line => line.state)).eql(['waiting', 'unavailable']);
    should(answered.plan).be.undefined();
  });

  it('should tell the ferret nothing about which secret fields an account holds, with real accounts saved', async () => {
    const withKey = planWorld(githubWith({ totp: true }));
    const without = planWorld(githubWith({ totp: false }));

    const first = await withKey.service.call(agent, { tool: 'task.plan', lines: [SITE_LINE] });
    const second = await without.service.call(agent, { tool: 'task.plan', lines: [SITE_LINE] });

    should(first.taskPlan?.lines.map(line => line.state)).eql(['waiting']);
    const text = JSON.stringify([first, second]);
    for (const key of ['candidates', 'history', 'flags', 'because', 'can', 'fields', 'totp', 'username'])
      should(text).not.containEql(`"${key}"`);
    for (const secret of ['secret-user', 'secret-label', 'GITHUB_WORK', 'GITHUB_HOME', 'si_0000', KEY])
      should(text).not.containEql(secret);
    const bare = (answered: unknown): string =>
      JSON.stringify(answered)
        .replace(/"id":"[^"]*"/gu, '"id":"-"')
        .replace(/!A\d+/gu, '!A-');
    should(bare(first)).equal(bare(second));
  });

  it('should plan for the calling session only, whatever the body says', async () => {
    const world = planWorld();

    await world.service.call(agent, { tool: 'task.plan', lines: [PASTE_LINE] });
    const named = AgentToolCallSchema.safeParse({ tool: 'task.plan', sessionId: 's2', lines: [PASTE_LINE] });

    should(world.proposed.map(entry => entry.sessionId)).eql(['s1']);
    should(named.success).be.false();
  });

  it('should audit how many lines were asked and nothing of them', async () => {
    const world = planWorld();

    await world.service.call(agent, { tool: 'task.plan', lines: [PASTE_LINE, SITE_LINE] });

    const records = world.audit.entries.filter(entry => entry.detail?.tool === 'task.plan');
    should(records.map(entry => entry.detail)).eql([{ tool: 'task.plan', by: 'agent', lines: 2 }]);
    const text = JSON.stringify(records);
    should(text).not.containEql('github.com');
    should(text).not.containEql('Actions');
  });
});

describe('secure.preapprove, kept for an older pane', () => {
  it('should go through the same propose call as task.plan and answer in the old shape', async () => {
    const world = planWorld();

    const old = await world.service.call(agent, { tool: 'secure.preapprove', items: [...OLD_ITEMS] });
    const next = await world.service.call(agent, { tool: 'task.plan', lines: [PASTE_LINE] });

    should(world.proposed.map(entry => entry.call)).eql([
      { tool: 'task.plan', lines: [PASTE_LINE] },
      { tool: 'task.plan', lines: [PASTE_LINE] },
    ]);
    const plan = CopyPlanSchema.parse(old.plan);
    should(plan.items).eql([...OLD_ITEMS]);
    should(old.taskPlan).be.undefined();
    should(old.summary).equal(
      'Asked the owner to approve 1 paste in advance (!A1). Until they answer, each paste asks them.',
    );
    should(next.taskPlan?.lines).eql([{ line: 0, state: 'waiting' }]);
  });
});

describe('secure.preapprove: a translated call only ever asks for pastes of one use', () => {
  it('should propose every item as a one-use paste line, whatever the body carried', async () => {
    const world = planWorld();
    const items = [
      ...OLD_ITEMS,
      { from: GH, to: { kind: 'browser', origin: 'https://vercel.com' } as const, why: 'the token field' },
    ];

    await world.service.call(agent, { tool: 'secure.preapprove', items, expiresInSeconds: 3_600 });

    const lines = world.proposed.flatMap(entry => entry.call.lines);
    should(lines.map(line => [line.kind, line.uses])).eql([
      ['paste', 1],
      ['paste', 1],
    ]);
    should(world.proposed[0]?.call.expiresInSeconds).equal(3_600);
  });
});

describe('the same refusals for both names', () => {
  for (const { name, call } of BOTH_NAMES) {
    it(`should refuse ${name} from a person, and where no plans are wired`, async () => {
      const world = planWorld();

      const byPerson = await refused(world.service.call(person, call));
      const unwired = await refused(agentToolWorld().service.call(agent, call));

      should([byPerson.code, unwired.code]).eql(['bad_request', 'unavailable']);
      should(world.proposed).eql([]);
      should(world.cards).eql([]);
    });

    it(`should refuse a fourth waiting plan from ${name} and raise no card for it`, async () => {
      const world = planWorld();
      for (let count = 0; count < TASK_PLAN_MAX_PENDING_PER_SESSION; count += 1) await world.service.call(agent, call);

      const fourth = await refused(world.service.call(agent, call));

      should(fourth.code).equal('capacity');
      should(world.cards).have.length(TASK_PLAN_MAX_PENDING_PER_SESSION);
    });
  }

  it('should read a refused body the same way under both names', () => {
    const tooMany = Array.from({ length: 11 }, () => PASTE_LINE);

    const results = [
      AgentToolCallSchema.safeParse({ tool: 'task.plan', lines: tooMany }).success,
      AgentToolCallSchema.safeParse({
        tool: 'secure.preapprove',
        items: tooMany.map(({ from, to, why }) => ({ from, to, why })),
      }).success,
      AgentToolCallSchema.safeParse({ tool: 'task.plan', lines: [] }).success,
      AgentToolCallSchema.safeParse({ tool: 'secure.preapprove', items: [] }).success,
    ];

    should(results).eql([false, false, false, false]);
  });
});
