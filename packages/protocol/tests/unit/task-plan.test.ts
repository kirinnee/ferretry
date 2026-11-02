import { describe, it } from 'bun:test';
import should from 'should';
import { z } from 'zod';
import { addTwoFactorKeySubject } from '../../src/lib/accounts.ts';
import { AgendaActionRequestSchema } from '../../src/lib/agenda.ts';
import { AgentToolCallSchema, AgentToolResultSchema, taskPlanCallOf } from '../../src/lib/agent-tools.ts';
import { sha256Hex } from '../../src/lib/mcp-oauth.ts';
import { CopyPlanSchema } from '../../src/lib/secure-copy.ts';
import * as plans from '../../src/lib/task-plan.ts';
import {
  canonicalTaskPlanApproval,
  copyPlanOf,
  GRANT_MISS_REASONS,
  GRANT_STOPPING_REASONS,
  grantMissLine,
  grantMissLineFor,
  grantMissWords,
  ruleMissWords,
  TASK_PLAN_MISS_AGENT_NOTE,
  TASK_PLAN_UNAVAILABLE_REASONS,
  type TaskPlan,
  TaskPlanAgentViewSchema,
  type TaskPlanApproval,
  TaskPlanCallSchema,
  type TaskPlanLinePins,
  TaskPlanSchema,
  taskPlanAgentView,
  taskPlanApprovalSubject,
  taskPlanCoversTool,
  taskPlanSelection,
  taskPlanSelectionNeedsPasskey,
} from '../../src/lib/task-plan.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const PLAN_ID = 'a'.repeat(32);
const STAGE = `tps_${'1'.repeat(24)}`;
const AT = '2026-11-01T14:00:00.000Z';
const LATER = '2026-11-01T16:00:00.000Z';
const GITHUB_A = 'si_000000000000000a';
const GITHUB_B = 'si_000000000000000b';
const SUDO = 'si_00000000000000cc';
const KEY_A = `L${'A'.repeat(24)}`;
const KEY_B = `L${'B'.repeat(24)}`;
const DEVICE = { kind: 'device', deviceId: 'fy_device_id_phone' } as const;

const candidate = (signIn: string, id: string, totp = true) => ({
  signIn,
  account: { id, label: id.toLowerCase() },
  username: 'kirinnee',
  place: { kind: 'site', domains: ['github.com'], match: [] },
  can: { username: true, password: true, totp },
  history: true,
});

const SIGN_IN_LINE = {
  kind: 'sign-in',
  line: 0,
  uses: 2,
  why: 'check the Actions settings',
  state: 'waiting',
  fields: ['username', 'password', 'totp'],
  candidates: [candidate(GITHUB_A, 'GITHUB_A'), candidate(GITHUB_B, 'GITHUB_B', false)],
  flags: ['one-factor'],
} as const;

const TERMINAL_LINE = {
  kind: 'terminal-sign-in',
  line: 1,
  uses: 1,
  why: 'install the package',
  state: 'waiting',
  fields: ['password'],
  candidates: [
    {
      signIn: SUDO,
      account: { id: 'KIRIN', label: 'kirin' },
      place: { kind: 'terminal', tool: 'sudo', host: 'kirin-box' },
      can: { username: false, password: true, totp: false },
      history: false,
    },
  ],
  flags: ['root', 'no-history'],
} as const;

const PASTE_LINE = {
  kind: 'paste',
  line: 2,
  uses: 1,
  why: 'the deploy token',
  state: 'waiting',
  from: { kind: 'command', program: 'gh' },
  to: { kind: 'terminal', program: 'vercel' },
} as const;

const PLAN = {
  v: 1,
  id: PLAN_ID,
  sessionId: 'mvxjh1lg-9f897e3b',
  agendaItemId: 'A193',
  lines: [SIGN_IN_LINE, TERMINAL_LINE, PASTE_LINE],
  state: 'pending',
  raisedAt: AT,
  expiresAt: LATER,
} as const;

const plan = (overrides: Partial<Record<keyof TaskPlan, unknown>> = {}): TaskPlan =>
  TaskPlanSchema.parse({ ...PLAN, ...overrides });

const PINS: ReadonlyMap<number, TaskPlanLinePins> = new Map([
  [0, { accountKey: KEY_A, placeKeys: ['github.com'], recipeVersion: 3, identities: ['0123456789abcdef'] }],
  [1, { accountKey: KEY_B, placeKeys: ['sudo@kirin-box'] }],
]);

const APPROVAL: TaskPlanApproval = {
  lines: [{ line: 0, signIn: GITHUB_A, totp: true }, { line: 1 }, { line: 2 }],
};

const signInAsk = { kind: 'sign-in', signIn: GITHUB_A, fields: ['username', 'password'], why: 'open the repo' };
const call = (lines: unknown[], extra: Record<string, unknown> = {}) => ({ tool: 'task.plan', lines, ...extra });

const approvedPlan = (totp: boolean, can: boolean): TaskPlan =>
  plan({
    state: 'approved',
    answered: { at: AT, by: DEVICE, proof: 'passkey' },
    lines: [
      {
        ...SIGN_IN_LINE,
        state: 'approved',
        candidates: [candidate(GITHUB_A, 'GITHUB_A', can), candidate(GITHUB_B, 'GITHUB_B', false)],
        flags: totp ? ['one-factor'] : [],
        approved: { signIn: GITHUB_A, totp, remaining: 2 },
      },
      { ...TERMINAL_LINE, state: 'declined' },
      { ...PASTE_LINE, state: 'approved', remaining: 1 },
    ],
  });

/** A selection staged for its passkey, as the stage route answers it. */
const STAGED = {
  stage: STAGE,
  plan: PLAN_ID,
  lines: [0, 2],
  codes: [0],
  summary: ['Line 1: sign in as GitHub · kirinnee on github.com with its password, 1 use', 'Line 3: paste, 1 use'],
  expiresAt: AT,
};

const cases: SchemaCase[] = [
  { name: 'stage id', schema: plans.TaskPlanStageIdSchema, value: STAGE },
  { name: 'line number', schema: plans.TaskPlanLineNumberSchema, value: 9 },
  { name: 'miss reason', schema: plans.GrantMissReasonSchema, value: 'form-changed' },
  { name: 'sign-in field', schema: plans.SignInFieldSchema, value: 'totp' },
  { name: 'sign-in ask', schema: plans.TaskPlanSignInAskSchema, value: { ...signInAsk, uses: 1 } },
  {
    name: 'sign-in ask by site',
    schema: plans.TaskPlanSignInAskSchema,
    value: { kind: 'sign-in', site: 'app.clickup.com', fields: ['password'], uses: 3, why: 'tidy the board' },
  },
  {
    name: 'terminal ask',
    schema: plans.TaskPlanTerminalAskSchema,
    value: { kind: 'terminal-sign-in', place: 'sudo@kirin-box', uses: 1, why: 'install' },
  },
  {
    name: 'paste ask',
    schema: plans.TaskPlanPasteAskSchema,
    value: { kind: 'paste', from: PASTE_LINE.from, to: PASTE_LINE.to, uses: 1, why: 'token' },
  },
  { name: 'line ask', schema: plans.TaskPlanLineAskSchema, value: { ...signInAsk, uses: 1 } },
  {
    name: 'call',
    schema: plans.TaskPlanCallSchema,
    value: call([{ ...signInAsk, uses: 1 }], { expiresInSeconds: 600 }),
  },
  { name: 'candidate', schema: plans.TaskPlanCandidateSchema, value: candidate(GITHUB_A, 'GITHUB_A') },
  { name: 'line state', schema: plans.TaskPlanLineStateSchema, value: 'used-up' },
  { name: 'line flag', schema: plans.TaskPlanLineFlagSchema, value: 'root' },
  { name: 'sign-in line', schema: plans.TaskPlanSignInLineSchema, value: SIGN_IN_LINE },
  { name: 'terminal line', schema: plans.TaskPlanTerminalLineSchema, value: TERMINAL_LINE },
  { name: 'paste line', schema: plans.TaskPlanPasteLineSchema, value: PASTE_LINE },
  { name: 'line', schema: plans.TaskPlanLineSchema, value: PASTE_LINE },
  { name: 'plan state', schema: plans.TaskPlanStateSchema, value: 'revoked' },
  { name: 'plan', schema: plans.TaskPlanSchema, value: PLAN },
  {
    name: 'plan staged at the machine',
    schema: plans.TaskPlanSchema,
    value: { ...PLAN, machineStage: { stage: STAGE, lines: [0, 1], askedAt: AT } },
  },
  { name: 'approved plan', schema: plans.TaskPlanSchema, value: approvedPlan(true, true) },
  { name: 'plan list', schema: plans.TaskPlanListSchema, value: { plans: [PLAN] } },
  { name: 'agent view', schema: plans.TaskPlanAgentViewSchema, value: taskPlanAgentView(approvedPlan(true, true)) },
  { name: 'approval', schema: plans.TaskPlanApprovalSchema, value: APPROVAL },
  { name: 'pins', schema: plans.TaskPlanLinePinsSchema, value: PINS.get(0) },
  { name: 'staged selection', schema: plans.TaskPlanStagedSchema, value: STAGED },
  { name: 'stage state', schema: plans.TaskPlanStageStateSchema, value: 'denied' },
  { name: 'stage view', schema: plans.TaskPlanStageViewSchema, value: { ...STAGED, state: 'waiting' } },
  { name: 'answered at once', schema: plans.TaskPlanApprovalAnswerSchema, value: { outcome: 'answered', plan: PLAN } },
  { name: 'answer staged', schema: plans.TaskPlanApprovalAnswerSchema, value: { outcome: 'staged', staged: STAGED } },
  {
    name: 'confirming',
    schema: plans.TaskPlanConfirmingSchema,
    value: { stage: STAGE, plan: PLAN_ID, agendaItemId: 'A1' },
  },
  { name: 'revoke all', schema: plans.TaskPlanRevokeSchema, value: {} },
  { name: 'revoke lines', schema: plans.TaskPlanRevokeSchema, value: { lines: [0, 2] } },
  { name: 'stage dropped', schema: plans.TaskPlanStageDroppedSchema, value: { stage: STAGE, dropped: true } },
];

describe('task plan schemas', () => {
  it('should round-trip every schema the module exports', () => {
    assertRoundTrips(cases);
    assertCoversEverySchema(plans, cases);
  });
});

describe('what a ferret may ask for (invariants 6 and 12)', () => {
  it('should default a line to one use and a plan to no expiry of its own', () => {
    const parsed = TaskPlanCallSchema.parse(call([signInAsk]));

    should(parsed.lines[0]?.uses).equal(1);
    should(parsed.expiresInSeconds).be.undefined();
  });

  it('should never take a place, a URL, a program path or a value of the ferret making on a line', () => {
    const smuggled = ['origin', 'url', 'program', 'path', 'domains', 'value', 'password', 'match'].map(key => ({
      name: `a sign-in line with ${key}`,
      schema: TaskPlanCallSchema,
      value: call([{ ...signInAsk, [key]: 'https://github.com.evil.example' }]),
    }));
    assertRejects([
      ...smuggled,
      {
        name: 'a terminal line with a program',
        schema: TaskPlanCallSchema,
        value: call([{ kind: 'terminal-sign-in', place: 'sudo@kirin-box', program: '/usr/bin/sudo', why: 'x' }]),
      },
      {
        name: 'a terminal line with fields',
        schema: TaskPlanCallSchema,
        value: call([{ kind: 'terminal-sign-in', place: 'sudo@kirin-box', fields: ['password'], why: 'x' }]),
      },
      {
        name: 'a terminal line naming a bare host, not tool@host',
        schema: TaskPlanCallSchema,
        value: call([{ kind: 'terminal-sign-in', place: 'kirin-box', why: 'x' }]),
      },
      {
        name: 'a site that is a URL',
        schema: TaskPlanCallSchema,
        value: call([{ kind: 'sign-in', site: 'https://github.com/login', fields: ['password'], why: 'x' }]),
      },
      {
        name: 'a paste with an extra field',
        schema: TaskPlanCallSchema,
        value: call([{ kind: 'paste', from: PASTE_LINE.from, to: PASTE_LINE.to, why: 'x', origin: 'https://x' }]),
      },
      { name: 'an unknown kind', schema: TaskPlanCallSchema, value: call([{ kind: 'ssh-key', why: 'x' }]) },
    ]);
  });

  it('should name a sign-in by exactly one of its id or a saved host', () => {
    assertRejects([
      {
        name: 'both',
        schema: TaskPlanCallSchema,
        value: call([{ ...signInAsk, site: 'github.com' }]),
      },
      {
        name: 'neither',
        schema: TaskPlanCallSchema,
        value: call([{ kind: 'sign-in', fields: ['password'], why: 'x' }]),
      },
      {
        name: 'a terminal line naming both',
        schema: TaskPlanCallSchema,
        value: call([{ kind: 'terminal-sign-in', signIn: SUDO, place: 'sudo@kirin-box', why: 'x' }]),
      },
    ]);
  });

  it('should refuse two lines for one sign-in, a field named twice, and no field at all', () => {
    assertRejects([
      { name: 'same sign-in twice', schema: TaskPlanCallSchema, value: call([signInAsk, { ...signInAsk, why: 'y' }]) },
      {
        name: 'same site twice',
        schema: TaskPlanCallSchema,
        value: call([
          { kind: 'sign-in', site: 'github.com', fields: ['password'], why: 'x' },
          { kind: 'sign-in', site: 'github.com', fields: ['username'], why: 'y' },
        ]),
      },
      {
        name: 'one sign-in as a page line and a terminal line',
        schema: TaskPlanCallSchema,
        value: call([signInAsk, { kind: 'terminal-sign-in', signIn: GITHUB_A, why: 'x' }]),
      },
      {
        name: 'a field twice',
        schema: TaskPlanCallSchema,
        value: call([{ ...signInAsk, fields: ['password', 'password'] }]),
      },
      { name: 'no field', schema: TaskPlanCallSchema, value: call([{ ...signInAsk, fields: [] }]) },
      { name: 'an unknown field', schema: TaskPlanCallSchema, value: call([{ ...signInAsk, fields: ['pin'] }]) },
    ]);
    // Two pastes, and one sign-in beside one site, are not the same sign-in on their face: the daemon resolves them.
    should(
      TaskPlanCallSchema.safeParse(
        call([PASTE_LINE, PASTE_LINE].map(({ kind, from, to, why }) => ({ kind, from, to, why }))),
      ).success,
    ).be.true();
  });

  it('should hold every limit: lines, uses, lifetime and the reason', () => {
    const pastes = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        kind: 'paste',
        from: PASTE_LINE.from,
        to: PASTE_LINE.to,
        why: `paste ${String(index)}`,
      }));
    const ok = (value: unknown) => TaskPlanCallSchema.safeParse(value).success;

    should([plans.TASK_PLAN_MAX_LINES, plans.TASK_PLAN_LINE_DEFAULT_USES, plans.TASK_PLAN_LINE_MAX_USES]).deepEqual([
      10, 1, 5,
    ]);
    should([
      plans.TASK_PLAN_DEFAULT_LIFETIME_SECONDS,
      plans.TASK_PLAN_MIN_LIFETIME_SECONDS,
      plans.TASK_PLAN_MAX_LIFETIME_SECONDS,
      plans.TASK_PLAN_STAGE_TTL_SECONDS,
    ]).deepEqual([7_200, 300, 86_400, 120]);
    should([
      plans.TASK_PLAN_MAX_CANDIDATES,
      plans.TASK_PLAN_MAX_PENDING_PER_SESSION,
      plans.TASK_PLAN_MAX_LIVE_PER_SESSION,
      plans.TASK_PLAN_MAX_PROPOSALS_PER_HOUR,
    ]).deepEqual([8, 3, 3, 6]);

    should([ok(call(pastes(10))), ok(call(pastes(11))), ok(call([]))]).deepEqual([true, false, false]);
    should([1, 5, 0, 6, 1.5].map(uses => ok(call([{ ...signInAsk, uses }])))).deepEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
    should([300, 86_400, 299, 86_401].map(expiresInSeconds => ok(call([signInAsk], { expiresInSeconds })))).deepEqual([
      true,
      true,
      false,
      false,
    ]);
    should(
      ['x'.repeat(140), 'x'.repeat(141), '', '   ', 'line\nbreak', 'bidi‮override'].map(why =>
        ok(call([{ ...signInAsk, why }])),
      ),
    ).deepEqual([true, false, false, false, false, false]);
    should(
      TaskPlanSchema.safeParse({
        ...PLAN,
        lines: [
          {
            ...SIGN_IN_LINE,
            candidates: Array.from({ length: 9 }, (_, index) =>
              candidate(`si_${index.toString(16).padStart(16, '0')}`, `GITHUB_${String(index)}`),
            ),
          },
        ],
      }).success,
    ).be.false();
  });

  it('should cover sudo, su and doas only, by the tool before the host', () => {
    should(['sudo@kirin-box', 'su@kirin-box', 'doas@kirin-box'].map(taskPlanCoversTool)).deepEqual([true, true, true]);
    should(
      ['ssh@build.example.com', 'npm@kirin-box', 'sudo', 'sudoedit@kirin-box', 'kirin-box'].map(taskPlanCoversTool),
    ).deepEqual([false, false, false, false, false]);
  });
});

describe('the plan the daemon keeps', () => {
  it('should refuse a sign-in line approved without a passkey, or a passkey from the machine', () => {
    const approved = approvedPlan(true, true);

    should(TaskPlanSchema.safeParse(approved).success).be.true();
    assertRejects([
      {
        name: 'no proof',
        schema: TaskPlanSchema,
        value: { ...approved, answered: { at: AT, by: DEVICE, proof: 'none' } },
      },
      {
        name: 'unanswered',
        schema: TaskPlanSchema,
        value: { ...approved, answered: undefined },
      },
      {
        name: 'a passkey the machine could never hold',
        schema: TaskPlanSchema,
        value: { ...approved, answered: { at: AT, by: { kind: 'host' }, proof: 'passkey' } },
      },
    ]);
    // Paste lines only keep the paste plan's rule: the machine answers them with no passkey.
    should(
      TaskPlanSchema.safeParse({
        ...PLAN,
        state: 'approved',
        answered: { at: AT, by: { kind: 'host' }, proof: 'none' },
        lines: [
          { ...SIGN_IN_LINE, state: 'declined' },
          { ...TERMINAL_LINE, state: 'declined' },
          { ...PASTE_LINE, state: 'approved', remaining: 1 },
        ],
      }).success,
    ).be.true();
  });

  it('should keep each line to what was asked and what the daemon found', () => {
    const approved = { signIn: GITHUB_A, totp: false, remaining: 1 };
    const withLine = (line: Record<string, unknown>, index = 0) => {
      const lines: unknown[] = [...PLAN.lines];
      lines[index] = line;
      return { ...PLAN, lines };
    };
    assertRejects([
      { name: 'lines out of order', schema: TaskPlanSchema, value: withLine({ ...SIGN_IN_LINE, line: 1 }) },
      {
        name: 'a terminal line that fills more than the password',
        schema: TaskPlanSchema,
        value: withLine({ ...TERMINAL_LINE, fields: ['username', 'password'] }, 1),
      },
      {
        name: 'approved for an account it never offered',
        schema: TaskPlanSchema,
        value: withLine({ ...SIGN_IN_LINE, state: 'approved', approved: { ...approved, signIn: SUDO } }),
      },
      {
        name: 'codes approved where they were not asked',
        schema: TaskPlanSchema,
        value: withLine({
          ...SIGN_IN_LINE,
          fields: ['password'],
          state: 'approved',
          approved: { ...approved, totp: true },
        }),
      },
      {
        name: 'more uses left than asked',
        schema: TaskPlanSchema,
        value: withLine({ ...SIGN_IN_LINE, state: 'approved', approved: { ...approved, remaining: 3 } }),
      },
      {
        name: 'an approval on an unticked line',
        schema: TaskPlanSchema,
        value: withLine({ ...SIGN_IN_LINE, state: 'declined', approved }),
      },
      {
        name: 'an approved line with no approval',
        schema: TaskPlanSchema,
        value: withLine({ ...SIGN_IN_LINE, state: 'approved' }),
      },
      {
        name: 'a preselect outside the candidates',
        schema: TaskPlanSchema,
        value: withLine({ ...SIGN_IN_LINE, preselect: { signIn: SUDO, why: 'project' } }),
      },
      {
        name: 'a reason on a waiting line',
        schema: TaskPlanSchema,
        value: withLine({ ...SIGN_IN_LINE, because: 'frame' }),
      },
      {
        name: 'a candidate twice',
        schema: TaskPlanSchema,
        value: withLine({ ...SIGN_IN_LINE, candidates: [candidate(GITHUB_A, 'A'), candidate(GITHUB_A, 'A')] }),
      },
      {
        name: 'uses left on an unticked paste',
        schema: TaskPlanSchema,
        value: withLine({ ...PASTE_LINE, remaining: 1 }, 2),
      },
      {
        name: 'more uses left on a paste than asked',
        schema: TaskPlanSchema,
        value: withLine({ ...PASTE_LINE, state: 'approved', remaining: 2 }, 2),
      },
      {
        name: 'a staged selection naming a line the plan lacks',
        schema: TaskPlanSchema,
        value: { ...PLAN, machineStage: { stage: STAGE, lines: [3], askedAt: AT } },
      },
      {
        name: 'a staged selection on an answered plan',
        schema: TaskPlanSchema,
        value: { ...approvedPlan(true, true), machineStage: { stage: STAGE, lines: [0], askedAt: AT } },
      },
    ]);
    should(TaskPlanSchema.safeParse(withLine({ ...PASTE_LINE, state: 'approved', remaining: 1 }, 2)).success).be.true();
    should(
      TaskPlanSchema.safeParse(
        withLine({ ...SIGN_IN_LINE, state: 'unavailable', candidates: [], flags: [], because: 'not-in-accounts' }),
      ).success,
    ).be.true();
  });
});

describe('what the ferret is told (invariant 24)', () => {
  it('should carry no key that says which secret fields an account holds', () => {
    const names: string[] = [];
    const walk = (node: unknown): void => {
      if (node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const child of node) walk(child);
        return;
      }
      const properties = (node as { properties?: unknown }).properties;
      if (properties !== null && typeof properties === 'object') names.push(...Object.keys(properties));
      for (const child of Object.values(node)) walk(child);
    };
    walk(z.toJSONSchema(TaskPlanAgentViewSchema, { io: 'output', unrepresentable: 'any' }));

    should(
      names.filter(name =>
        /^(can|history|flags|because|totp|fields|candidates|username|password|code|reason)$/u.test(name),
      ),
    ).deepEqual([]);
  });

  it('should tell the ferret the same about an account whether or not it makes codes, or the owner ticked them', () => {
    const views = [approvedPlan(true, true), approvedPlan(false, true), approvedPlan(false, false)].map(view =>
      JSON.stringify(taskPlanAgentView(view)),
    );

    should(new Set(views).size).equal(1);
    should(JSON.parse(views[0] ?? '{}')).deepEqual({
      id: PLAN_ID,
      agendaItemId: 'A193',
      state: 'approved',
      expiresAt: LATER,
      lines: [
        { line: 0, state: 'approved', account: { id: 'GITHUB_A', label: 'github_a' }, remaining: 2 },
        { line: 1, state: 'declined' },
        { line: 2, state: 'approved', remaining: 1 },
      ],
    });
  });

  it('should give the ferret one sentence for every miss', () => {
    should(TASK_PLAN_MISS_AGENT_NOTE).equal("Your task plan didn't cover this, so the owner was asked.");
    should(AgentToolResultSchema.safeParse({ summary: 'x', taskPlan: taskPlanAgentView(plan()) }).success).be.true();
  });
});

describe('approving: the owner only narrows (invariant 9)', () => {
  it('should select exactly the ticked lines, sorted, with codes only where ticked', () => {
    const selection = taskPlanSelection(plan(), { lines: [{ line: 2 }, { line: 0, signIn: GITHUB_A }, { line: 1 }] });

    should(selection).deepEqual({
      ok: true,
      lines: [
        { kind: 'sign-in', line: 0, signIn: GITHUB_A, fields: ['password', 'username'], uses: 2 },
        { kind: 'terminal-sign-in', line: 1, signIn: SUDO, fields: ['password'], uses: 1 },
        { kind: 'paste', line: 2, from: PASTE_LINE.from, to: PASTE_LINE.to, uses: 1 },
      ],
    });
  });

  it('should refuse anything the ferret did not ask, or the daemon did not find', () => {
    const refused = (approval: TaskPlanApproval, current: TaskPlan = plan()) => {
      const selection = taskPlanSelection(current, approval);
      return selection.ok ? 'accepted' : selection.reason;
    };

    should(refused({ lines: [{ line: 0 }] })).equal('pick one of the accounts first');
    should(refused({ lines: [{ line: 0, signIn: SUDO }] })).equal('pick one of the accounts the card lists');
    should(refused({ lines: [{ line: 0, signIn: GITHUB_B, totp: true }] })).equal(
      'this account has no automatic codes',
    );
    should(refused({ lines: [{ line: 1, totp: true }] })).equal('the ferret did not ask for codes on this line');
    should(refused({ lines: [{ line: 2, signIn: GITHUB_A }] })).equal('a paste line has no account or code tick');
    should(refused({ lines: [{ line: 2, totp: false }] })).equal('a paste line has no account or code tick');
    should(refused({ lines: [{ line: 3 }] })).equal('the plan has no such line');
    should(refused({ lines: [{ line: 2 }, { line: 2 }] })).equal('tick each line once');
    should(refused({ lines: [{ line: 1 }] }, plan({ state: 'expired' }))).equal(
      'the plan is no longer waiting for an answer',
    );
    const unavailable = plan({
      lines: [{ ...SIGN_IN_LINE, state: 'unavailable', candidates: [], flags: [], because: 'via-provider' }],
    });
    should(refused({ lines: [{ line: 0 }] }, unavailable)).equal("that line can't be ticked");
    const codeOnly = plan({ lines: [{ ...SIGN_IN_LINE, fields: ['totp'] }] });
    should(refused({ lines: [{ line: 0, signIn: GITHUB_A }] }, codeOnly)).equal(
      'tick the code, or leave the line unticked',
    );
    should(refused({ lines: [{ line: 0, signIn: GITHUB_A, totp: true }] }, codeOnly)).equal('accepted');
  });

  it('should ask for the passkey whenever any line is ticked, a paste line too, and never for a decline (!A244)', () => {
    const needs = (approval: TaskPlanApproval) => {
      const selection = taskPlanSelection(plan(), approval);
      return selection.ok && taskPlanSelectionNeedsPasskey(selection.lines);
    };

    should([
      needs({ lines: [] }),
      needs({ lines: [{ line: 2 }] }),
      needs({ lines: [{ line: 1 }, { line: 2 }] }),
    ]).deepEqual([false, true, true]);
    should(needs({ lines: [{ line: 0, signIn: GITHUB_A }] })).be.true();
  });
});

describe('the bytes the passkey is bound to (invariant 4)', () => {
  const subjectOf = (current: TaskPlan, approval: TaskPlanApproval, pins = PINS, stage = STAGE): string => {
    const canonical = canonicalTaskPlanApproval(current, approval, pins);
    if (!canonical.ok) throw new Error(canonical.reason);
    return taskPlanApprovalSubject(stage, canonical.text);
  };

  it('should be deterministic, whatever order the ticks and the pins came in', () => {
    const shuffled: TaskPlanApproval = { lines: [...APPROVAL.lines].reverse() };
    const reordered = new Map([
      [1, { accountKey: KEY_B, placeKeys: ['sudo@kirin-box'] }],
      [0, { accountKey: KEY_A, placeKeys: ['github.com'], recipeVersion: 3, identities: ['0123456789abcdef'] }],
    ]);

    should(subjectOf(plan(), shuffled, reordered)).equal(subjectOf(plan(), APPROVAL));
    should(subjectOf(plan(), APPROVAL)).match(/^[0-9a-f]{64}$/u);
  });

  it('should write the canonical text the daemon and the app both bind', () => {
    const canonical = canonicalTaskPlanApproval(plan(), APPROVAL, PINS);

    should(canonical.ok && canonical.text).equal(
      JSON.stringify({
        expiresAt: LATER,
        lines: [
          {
            account: KEY_A,
            fields: ['password', 'totp', 'username'],
            identities: ['0123456789abcdef'],
            kind: 'sign-in',
            line: 0,
            placeKeys: ['github.com'],
            recipeVersion: 3,
            signIn: GITHUB_A,
            uses: 2,
          },
          {
            account: KEY_B,
            fields: ['password'],
            identities: null,
            kind: 'terminal-sign-in',
            line: 1,
            placeKeys: ['sudo@kirin-box'],
            recipeVersion: null,
            signIn: SUDO,
            uses: 1,
          },
          { from: PASTE_LINE.from, kind: 'paste', line: 2, to: PASTE_LINE.to, uses: 1 },
        ],
        plan: PLAN_ID,
        session: PLAN.sessionId,
        v: 1,
      }),
    );
  });

  it('should change the subject when any one bound thing changes', () => {
    const base = subjectOf(plan(), APPROVAL);
    const withPins = (line: number, change: Partial<TaskPlanLinePins>) =>
      new Map([...PINS].map(([key, pins]) => [key, key === line ? { ...pins, ...change } : pins]));
    const withLine = (change: Record<string, unknown>) =>
      plan({ lines: [{ ...SIGN_IN_LINE, ...change }, TERMINAL_LINE, PASTE_LINE] });

    const variants: Record<string, string> = {
      plan: subjectOf(plan({ id: 'b'.repeat(32) }), APPROVAL),
      session: subjectOf(plan({ sessionId: 'another-session' }), APPROVAL),
      expiry: subjectOf(plan({ expiresAt: '2026-11-01T16:00:01.000Z' }), APPROVAL),
      'the lines ticked': subjectOf(plan(), { lines: APPROVAL.lines.slice(0, 2) }),
      'the account picked': subjectOf(plan(), { lines: [{ line: 0, signIn: GITHUB_B }, { line: 1 }, { line: 2 }] }),
      'the account key': subjectOf(plan(), APPROVAL, withPins(0, { accountKey: KEY_B })),
      'the place keys': subjectOf(plan(), APPROVAL, withPins(0, { placeKeys: ['github.com', 'gist.github.com'] })),
      'the fields': subjectOf(withLine({ fields: ['password', 'totp'] }), APPROVAL),
      'the code tick': subjectOf(plan(), {
        lines: [{ line: 0, signIn: GITHUB_A, totp: false }, { line: 1 }, { line: 2 }],
      }),
      'the uses': subjectOf(withLine({ uses: 3 }), APPROVAL),
      'the recipe version': subjectOf(plan(), APPROVAL, withPins(0, { recipeVersion: 4 })),
      'no recipe version': subjectOf(plan(), APPROVAL, withPins(0, { recipeVersion: undefined })),
      'the identities': subjectOf(plan(), APPROVAL, withPins(0, { identities: ['fedcba9876543210'] })),
      'no identities yet': subjectOf(plan(), APPROVAL, withPins(0, { identities: undefined })),
      'the stage': subjectOf(plan(), APPROVAL, PINS, `tps_${'2'.repeat(24)}`),
    };

    for (const [what, subject] of Object.entries(variants))
      should(subject).not.equal(base, `${what} did not change it`);
    should(new Set(Object.values(variants)).size).equal(Object.keys(variants).length);
  });

  it('should keep its domain apart from every other bound act', () => {
    const canonical = canonicalTaskPlanApproval(plan(), APPROVAL, PINS);
    const text = canonical.ok ? canonical.text : '';

    should(taskPlanApprovalSubject(STAGE, text)).equal(
      sha256Hex(`ferretry.task-plan.v1\0${STAGE}\0${sha256Hex(text)}`),
    );
    should(taskPlanApprovalSubject(STAGE, text)).not.equal(addTwoFactorKeySubject(KEY_A, `st_${'1'.repeat(24)}`));
  });

  it('should refuse to bind a ticked sign-in line it has no valid pins for', () => {
    const missing = canonicalTaskPlanApproval(plan(), APPROVAL, new Map([[0, PINS.get(0) as TaskPlanLinePins]]));
    const empty = canonicalTaskPlanApproval(
      plan(),
      APPROVAL,
      new Map([...PINS, [1, { accountKey: KEY_B, placeKeys: [] }]]),
    );
    const notAKey = canonicalTaskPlanApproval(
      plan(),
      APPROVAL,
      new Map([...PINS, [1, { accountKey: 'GITHUB_A', placeKeys: ['sudo@kirin-box'] }]]),
    );

    for (const result of [missing, empty, notAKey]) should(result).containEql({ ok: false, line: 1 });
    // A paste line binds its route, and needs no pins.
    should(canonicalTaskPlanApproval(plan(), { lines: [{ line: 2 }] }, new Map()).ok).be.true();
  });
});

describe('why a line did not apply', () => {
  it('should have one sentence for every reason but not-here', () => {
    for (const reason of GRANT_MISS_REASONS) {
      const words = grantMissWords(reason);
      if (reason === 'not-here') should(words).be.undefined();
      else should(words).be.a.String().and.not.be.empty();
    }
    should(new Set(GRANT_MISS_REASONS.map(grantMissWords)).size).equal(GRANT_MISS_REASONS.length);
  });

  it('should say the line from 1, as the owner reads it, and nothing for not-here', () => {
    should(grantMissLine(1, 'form-changed')).equal(
      "Task plan line 2 didn't apply: the sign-in form changed since you approved it.",
    );
    should(grantMissLine(0, 'not-here')).be.undefined();
  });

  it('should name the propose-time and the stopping reasons from the one list', () => {
    for (const reason of [...TASK_PLAN_UNAVAILABLE_REASONS, ...GRANT_STOPPING_REASONS])
      should(GRANT_MISS_REASONS).containEql(reason);
  });

  it('should name the standing rule misses, and stop on the ones that change what the owner approved', () => {
    for (const reason of [
      'suspended',
      'out-of-scope',
      'account-changed',
      'factor-changed',
      'proof-invalid',
      'no-history',
      'code-without-sign-in',
      'scripted-origin',
    ] as const)
      should(GRANT_MISS_REASONS).containEql(reason);
    should(GRANT_STOPPING_REASONS).containDeep([
      'account-changed',
      'factor-changed',
      'proof-invalid',
      'scripted-origin',
    ]);
    // Scope and history are not drift: a ferret outside the scope, or a form with no taps yet, suspends nothing.
    should(GRANT_STOPPING_REASONS).not.containEql('out-of-scope');
    should(GRANT_STOPPING_REASONS).not.containEql('no-history');
  });

  it("should say a plan line's miss by its line, and a rule's by the rule, suspended where it stops", () => {
    // Act / Assert — the plan's words are unchanged
    should(grantMissLineFor({ by: 'plan', line: 1, outcome: 'did-not-apply', reason: 'form-changed' })).equal(
      grantMissLine(1, 'form-changed'),
    );
    should(grantMissLineFor({ by: 'rule', outcome: 'did-not-apply', reason: 'form-changed' })).equal(
      "Your standing rule for this sign-in didn't apply: the sign-in form changed since you approved it. The rule is suspended until you approve it again.",
    );
    should(grantMissLineFor({ by: 'rule', outcome: 'did-not-apply', reason: 'scripted-origin' })).equal(
      "Your standing rule for this sign-in didn't apply: a ferret ran a page script on this site. The rule is suspended until you approve it again.",
    );
    should(grantMissLineFor({ by: 'rule', outcome: 'did-not-apply', reason: 'suspended' })).equal(
      "Your standing rule for this sign-in didn't apply: it was suspended earlier. The rule is suspended until you approve it again.",
    );
    // A miss that is not drift says why, and nothing about a suspension.
    should(grantMissLineFor({ by: 'rule', outcome: 'did-not-apply', reason: 'rate' })).equal(
      "Your standing rule for this sign-in didn't apply: too many sign-ins were filled in the last hour.",
    );
    should(grantMissLineFor({ by: 'rule', outcome: 'did-not-apply', reason: 'out-of-scope' })).equal(
      "Your standing rule for this sign-in didn't apply: it doesn't cover this ferret's session or project.",
    );
    // Per source: a rule expires, it is not a plan that ended.
    should(grantMissLineFor({ by: 'rule', outcome: 'did-not-apply', reason: 'expired' })).equal(
      "Your standing rule for this sign-in didn't apply: the rule had expired.",
    );
    should(grantMissLineFor({ by: 'rule', outcome: 'did-not-apply', reason: 'sign-in-gone' })).equal(
      "Your standing rule for this sign-in didn't apply: the sign-in was removed or moved to another account. The rule is suspended.",
    );
    // Nothing to say: a fill, a note with no reason, or not-here.
    should(grantMissLineFor({ by: 'rule', outcome: 'filled' })).be.undefined();
    should(grantMissLineFor({ by: 'rule', outcome: 'did-not-apply' })).be.undefined();
    should(grantMissLineFor({ by: 'rule', outcome: 'did-not-apply', reason: 'not-here' })).be.undefined();
    should(grantMissLineFor({ by: 'plan', line: 0, outcome: 'did-not-apply', reason: 'not-here' })).be.undefined();
    for (const reason of GRANT_MISS_REASONS)
      if (reason !== 'not-here') should(ruleMissWords(reason)).be.a.String().and.not.be.empty();
  });
});

describe('the paste plan it widens (invariant 30)', () => {
  const preapprove = {
    tool: 'secure.preapprove',
    items: [
      { from: { kind: 'command', program: 'gh' }, to: { kind: 'terminal', program: 'vercel' }, why: 'the token' },
      {
        from: { kind: 'browser', origin: 'https://github.com' },
        to: { kind: 'secret', name: 'GH_TOKEN' },
        why: 'keep it',
      },
    ],
    expiresInSeconds: 900,
  };

  it('should read secure.preapprove as a task plan of one-use paste lines', () => {
    const parsed = AgentToolCallSchema.parse(preapprove);
    if (parsed.tool !== 'secure.preapprove') throw new Error('not a preapprove');
    const translated = taskPlanCallOf(parsed);

    should(TaskPlanCallSchema.parse(translated)).deepEqual(translated);
    should(translated).deepEqual({
      tool: 'task.plan',
      lines: preapprove.items.map(item => ({ kind: 'paste', ...item, uses: 1 })),
      expiresInSeconds: 900,
    });
  });

  it('should answer secure.preapprove in the old plan shape, paste lines only', () => {
    const answered = approvedPlan(true, true);
    const pending = copyPlanOf(plan());

    should(CopyPlanSchema.parse(pending)).deepEqual(pending);
    should(pending).deepEqual({
      id: PLAN_ID,
      sessionId: PLAN.sessionId,
      agendaItemId: 'A193',
      items: [{ from: PASTE_LINE.from, to: PASTE_LINE.to, why: PASTE_LINE.why }],
      state: 'pending',
      raisedAt: AT,
      expiresAt: LATER,
    });
    should(copyPlanOf(answered)).containEql({ state: 'approved', approved: [0] });
    should(copyPlanOf(plan({ state: 'revoked', answered: { at: AT, by: DEVICE, proof: 'none' } }))).containEql({
      state: 'expired',
      approved: [],
    });
    should(copyPlanOf(plan({ lines: [SIGN_IN_LINE] }))).be.undefined();
  });
});

describe('one sign-in, one line (secrev-1258 L1)', () => {
  // The ferret named GITHUB_A on line 1, and asked for "github.com" on line 0, whose picker also offers GITHUB_A.
  const named = {
    ...SIGN_IN_LINE,
    line: 1,
    fields: ['password'],
    candidates: [candidate(GITHUB_A, 'GITHUB_A')],
    flags: [],
  };
  const overlapping = () => plan({ lines: [SIGN_IN_LINE, named, { ...PASTE_LINE, line: 2 }] });

  it('should refuse to tick the same account on two lines', () => {
    const twice = taskPlanSelection(overlapping(), { lines: [{ line: 0, signIn: GITHUB_A }, { line: 1 }] });
    const apart = taskPlanSelection(overlapping(), { lines: [{ line: 0, signIn: GITHUB_B }, { line: 1 }] });

    should(twice).deepEqual({ ok: false, line: 1, reason: 'this account is already ticked on line 1' });
    should(apart.ok).be.true();
    should(
      canonicalTaskPlanApproval(overlapping(), { lines: [{ line: 0, signIn: GITHUB_A }, { line: 1 }] }, PINS),
    ).containEql({ ok: false, line: 1 });
  });

  it('should refuse a plan record with one sign-in approved on two lines', () => {
    const approved = { signIn: GITHUB_A, totp: false, remaining: 1 };
    const record = (second: string) => ({
      ...PLAN,
      state: 'approved',
      answered: { at: AT, by: DEVICE, proof: 'passkey' },
      lines: [
        { ...SIGN_IN_LINE, state: 'approved', approved },
        {
          ...named,
          candidates: [candidate(GITHUB_A, 'GITHUB_A'), candidate(GITHUB_B, 'GITHUB_B')],
          state: 'approved',
          approved: { ...approved, signIn: second },
        },
        { ...PASTE_LINE, state: 'declined' },
      ],
    });

    should(TaskPlanSchema.safeParse(record(GITHUB_B)).success).be.true();
    should(TaskPlanSchema.safeParse(record(GITHUB_A)).success).be.false();
  });
});

describe('a line fills only where its kind may (secrev-1258 L2)', () => {
  const ssh = { kind: 'terminal', tool: 'ssh', host: 'kirin-box', dest: 'build.example.com' };
  const terminalWith = (place: unknown, state = 'waiting') => ({
    ...PLAN,
    lines: [
      SIGN_IN_LINE,
      {
        ...TERMINAL_LINE,
        state,
        candidates: [{ ...TERMINAL_LINE.candidates[0], place }],
        ...(state === 'unavailable' ? { because: 'tool-not-covered' } : {}),
      },
      PASTE_LINE,
    ],
  });

  it('should bind a terminal line only when every pinned key is sudo, su or doas', () => {
    const pinned = (keys: string[]) =>
      canonicalTaskPlanApproval(
        plan(),
        { lines: [{ line: 1 }] },
        new Map([[1, { accountKey: KEY_B, placeKeys: keys }]]),
      );

    should(pinned(['sudo@kirin-box']).ok).be.true();
    should(pinned(['doas@kirin-box', 'su@kirin-box']).ok).be.true();
    for (const keys of [['ssh@build.example.com'], ['sudo@kirin-box', 'npm@kirin-box'], ['kirin-box']])
      should(pinned(keys)).deepEqual({
        ok: false,
        line: 1,
        reason: 'a terminal sign-in is pinned to sudo, su or doas only',
      });
  });

  it('should bind a page line only to web hosts', () => {
    const pinned = (keys: string[]) =>
      canonicalTaskPlanApproval(
        plan(),
        { lines: [{ line: 0, signIn: GITHUB_A }] },
        new Map([[0, { accountKey: KEY_A, placeKeys: keys }]]),
      );

    should(pinned(['github.com', 'gist.github.com']).ok).be.true();
    should(pinned(['github.com', 'sudo@kirin-box'])).deepEqual({
      ok: false,
      line: 0,
      reason: 'a page sign-in is pinned to web hosts only',
    });
  });

  it('should offer a terminal line sudo, su or doas candidates only, and a page line sites only', () => {
    should(
      TaskPlanSchema.safeParse(terminalWith({ kind: 'terminal', tool: 'su', host: 'kirin-box' })).success,
    ).be.true();
    assertRejects([
      { name: 'an ssh candidate on a waiting terminal line', schema: TaskPlanSchema, value: terminalWith(ssh) },
      {
        name: 'a site candidate on a terminal line',
        schema: TaskPlanSchema,
        value: terminalWith({ kind: 'site', domains: ['github.com'], match: [] }),
      },
      {
        name: 'a terminal candidate on a page line',
        schema: TaskPlanSchema,
        value: {
          ...PLAN,
          lines: [
            {
              ...SIGN_IN_LINE,
              candidates: [{ ...candidate(GITHUB_A, 'GITHUB_A'), place: TERMINAL_LINE.candidates[0].place }],
            },
            TERMINAL_LINE,
            PASTE_LINE,
          ],
        },
      },
    ]);
    // An unavailable line can't be ticked, so it may show the owner the ssh sign-in it can't cover.
    should(TaskPlanSchema.safeParse(terminalWith(ssh, 'unavailable')).success).be.true();
  });
});

describe('a paste-plan item is not a line number (secrev-1258 info 1)', () => {
  it('should map each item copyPlanOf numbers back to its plan line, and nothing else', () => {
    const mixed = plan({
      lines: [
        SIGN_IN_LINE,
        { ...PASTE_LINE, line: 1 },
        { ...TERMINAL_LINE, line: 2 },
        { ...PASTE_LINE, line: 3, why: 'second' },
      ],
    });
    const items = copyPlanOf(mixed)?.items ?? [];

    should(items.map((_, item) => plans.taskPlanLineOfCopyItem(mixed, item))).deepEqual([1, 3]);
    should([2, -1, 0.5].map(item => plans.taskPlanLineOfCopyItem(mixed, item))).deepEqual([
      undefined,
      undefined,
      undefined,
    ]);
    should(plans.taskPlanLineOfCopyItem(plan({ lines: [SIGN_IN_LINE] }), 0)).be.undefined();
  });
});

describe('the owner routes’ shapes (R3a-2)', () => {
  it('should refuse a staged selection with no line, an unknown stage state, or a revoke naming a line twice', () => {
    assertRejects([
      {
        name: 'a stage with no line',
        schema: plans.TaskPlanStagedSchema,
        value: { ...STAGED, lines: [], summary: [] },
      },
      {
        name: 'a stage of a 2FA seed',
        schema: plans.TaskPlanStagedSchema,
        value: { ...STAGED, stage: `st_${'1'.repeat(24)}` },
      },
      { name: 'a summary on two lines', schema: plans.TaskPlanStagedSchema, value: { ...STAGED, summary: ['a\nb'] } },
      { name: 'a stage committed', schema: plans.TaskPlanStageViewSchema, value: { ...STAGED, state: 'committed' } },
      { name: 'a revoke naming a line twice', schema: plans.TaskPlanRevokeSchema, value: { lines: [1, 1] } },
      { name: 'a revoke with an empty list', schema: plans.TaskPlanRevokeSchema, value: { lines: [] } },
      { name: 'a revoke with a field of its own', schema: plans.TaskPlanRevokeSchema, value: { all: true } },
    ]);
  });
});

describe('the agenda taskPlan ref is the daemon’s only (R3a-2)', () => {
  it("should refuse a ferret's agenda add that carries a taskPlan ref, while the same add without one passes", () => {
    const add = { action: 'add', subject: 'Allow these for this task?', why: 'a task', howToResolve: 'tick them' };

    should(AgendaActionRequestSchema.safeParse(add).success).be.true();
    should(AgendaActionRequestSchema.safeParse({ ...add, taskPlan: { planId: PLAN_ID } }).success).be.false();
    should(AgendaActionRequestSchema.safeParse({ ...add, copyPlan: { planId: PLAN_ID } }).success).be.false();
  });
});
