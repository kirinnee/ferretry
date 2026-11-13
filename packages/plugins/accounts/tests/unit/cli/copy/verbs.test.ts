import { afterEach, beforeEach, expect, it } from 'bun:test';
import type { PluginClient, VerbInvocation } from '@ferretry/kernel/manifest';
import cli from '../../../../cli/index.ts';
import { OWNER_COMMAND_REFUSAL } from '../../../../cli/lib/shared.ts';

/** The owner's own shell: no ferret session and no agent credential in the environment (a test may run inside a pane). */
const PANE_VARIABLES = ['FY_SESSION_ID', 'FY_SESSION_TOKEN', 'FY_SESSION_BOARD_CAPABILITY'] as const;
const kept = new Map<string, string | undefined>();
beforeEach(() => {
  for (const name of PANE_VARIABLES) {
    kept.set(name, process.env[name]);
    delete process.env[name];
  }
});
afterEach(() => {
  for (const name of PANE_VARIABLES) {
    const value = kept.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/** Every copy and plan verb, driven through the real CLI half over a client that records each call it is asked for. */

const RULE_ID = 'a1b2c3d4'.padEnd(32, '0');
const RULE = {
  id: RULE_ID,
  from: { kind: 'command', program: 'gh' },
  to: { kind: 'terminal', program: 'vercel' },
  used: 0,
  createdAt: '2026-10-31T12:00:00.000Z',
  createdBy: { kind: 'host' },
};
const STAGE = `prs_${'1'.repeat(24)}`;
const STAGED = {
  stage: STAGE,
  kind: 'rule',
  does: 'Ferretry pastes what gh prints into vercel in a terminal, for any ferret on this machine, without asking.',
  rows: [{ label: 'From', value: 'what gh prints' }],
  runsAnything: false,
  expiresAt: '2026-10-31T12:02:00.000Z',
};
const PLAN_ID = 'feedbeef'.padEnd(32, '0');
const PLAN = {
  v: 1,
  id: PLAN_ID,
  sessionId: 's1',
  agendaItemId: 'A9',
  lines: [
    {
      kind: 'paste',
      line: 0,
      uses: 1,
      why: 'the deploy token',
      state: 'waiting',
      from: { kind: 'command', program: 'gh' },
      to: { kind: 'terminal', program: 'vercel' },
    },
  ],
  state: 'pending',
  raisedAt: '2026-11-01T12:00:00.000Z',
  expiresAt: '2026-11-01T14:00:00.000Z',
};
const PLAN_STAGE = `tps_${'a'.repeat(24)}`;

function world(options: { fail?: { status: number; code: string } } = {}) {
  const calls: { route: string; init?: { params?: unknown; query?: unknown; body?: unknown } }[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const client = {
    call: async (route: string, init?: { params?: unknown; query?: unknown; body?: unknown }) => {
      calls.push({ route, init });
      if (options.fail !== undefined)
        throw Object.assign(new Error('refused'), { name: 'DaemonRefusal', ...options.fail });
      switch (route) {
        case 'GET /v1/ferrets/:ferretId/copies':
          return { copies: [] };
        case 'GET /v1/copy-rules':
          return { rules: [RULE] };
        case 'GET /v1/copy-rules/settings':
          return { settings: { allowProfileTargets: false }, profileRules: [] };
        case 'PUT /v1/copy-rules/settings':
          return init?.body;
        case 'POST /v1/copy-rules/stages':
        case 'POST /v1/copy-rules/settings/stages':
          return STAGED;
        case 'GET /v1/copy-rules/stages/:stage':
          return { ...STAGED, state: 'approved', rule: RULE_ID };
        case 'DELETE /v1/copy-rules/:ruleId':
          return { removed: true };
        case 'GET /v1/accounts/plans':
          return { plans: [PLAN] };
        case 'POST /v1/ferrets/:ferretId/task-plans/:planId/approval':
          return {
            outcome: 'staged',
            staged: {
              stage: PLAN_STAGE,
              plan: PLAN_ID,
              lines: [0],
              codes: [],
              summary: ['Paste what gh prints into vercel'],
              expiresAt: '2026-11-01T12:02:00.000Z',
            },
          };
        case 'POST /v1/ferrets/:ferretId/task-plans/:planId/approval/:stage/confirm-in-app':
          return { stage: PLAN_STAGE, plan: PLAN_ID, agendaItemId: 'A9' };
        case 'GET /v1/ferrets/:ferretId/task-plans/:planId/approval/:stage':
          return {
            stage: PLAN_STAGE,
            plan: PLAN_ID,
            lines: [0],
            codes: [],
            summary: ['Paste'],
            expiresAt: '2026-11-01T12:02:00.000Z',
            state: 'approved',
          };
        case 'POST /v1/ferrets/:ferretId/task-plans/:planId/revoke':
          return { ...PLAN, state: 'revoked' };
        default:
          throw new Error(`unexpected route ${route}`);
      }
    },
  } as unknown as PluginClient;
  const half = cli.build!({
    manifest: cli.manifest,
    client,
    clock: { now: () => new Date().toISOString() as never, nowMs: () => Date.now() },
    sleep: async () => undefined,
    io: { out: (text: string) => out.push(text), err: (text: string) => err.push(text), isTty: false },
  });
  const run = async (verb: string, invocation: VerbInvocation) =>
    await (half.verbs as Record<string, (invocation: VerbInvocation) => Promise<number>>)[verb]!(invocation);
  return { calls, out, err, run };
}

const VERBS: readonly [string, VerbInvocation, readonly string[]][] = [
  ['copy ls', { args: [], options: { session: 's1' } }, ['GET /v1/ferrets/:ferretId/copies']],
  ['copy rules ls', { args: [], options: {} }, ['GET /v1/copy-rules', 'GET /v1/copy-rules/settings']],
  [
    'copy rules add',
    { args: [], options: { from: 'command:gh', to: 'terminal:vercel' } },
    ['POST /v1/copy-rules/stages', 'GET /v1/copy-rules/stages/:stage'],
  ],
  ['copy rules profile', { args: ['off'], options: {} }, ['PUT /v1/copy-rules/settings']],
  ['copy rules rm', { args: ['a1b2'], options: {} }, ['GET /v1/copy-rules', 'DELETE /v1/copy-rules/:ruleId']],
  ['copy plan ls', { args: [], options: {} }, ['GET /v1/accounts/plans']],
  [
    'copy plan approve',
    { args: ['feed', '1'], options: {} },
    ['GET /v1/accounts/plans', 'POST /v1/ferrets/:ferretId/task-plans/:planId/approval'],
  ],
  [
    'copy plan revoke',
    { args: ['feed', '1'], options: {} },
    ['GET /v1/accounts/plans', 'POST /v1/ferrets/:ferretId/task-plans/:planId/revoke'],
  ],
  ['plan ls', { args: [], options: { session: 's1' } }, ['GET /v1/accounts/plans']],
  [
    'plan approve',
    { args: ['feed', '1'], options: {} },
    ['GET /v1/accounts/plans', 'POST /v1/ferrets/:ferretId/task-plans/:planId/approval'],
  ],
  [
    'plan revoke',
    { args: ['feed'], options: {} },
    ['GET /v1/accounts/plans', 'POST /v1/ferrets/:ferretId/task-plans/:planId/revoke'],
  ],
];

for (const [verb, invocation, routes] of VERBS) {
  it(`V-0199 ${verb} is answered by the real controller and gateway, not the skeleton`, async () => {
    const w = world();
    expect(await w.run(verb, invocation)).toBe(0);
    expect(w.err).toEqual([]);
    expect(w.out.join('')).not.toContain('not built');
    expect(w.calls.map(call => call.route)).toEqual(expect.arrayContaining([...routes]));
  });
}

it('V-0199 plan ls asks only for the named session, and plan approve names the ferret in the path', async () => {
  const w = world();
  await w.run('plan ls', { args: [], options: { session: 's1' } });
  expect(w.calls[0]).toEqual({ route: 'GET /v1/accounts/plans', init: { query: { session: 's1' } } });
  await w.run('plan approve', { args: ['feed', '1'], options: {} });
  const staged = w.calls.find(call => call.route === 'POST /v1/ferrets/:ferretId/task-plans/:planId/approval');
  expect(staged?.init?.params).toEqual({ ferretId: 's1', planId: PLAN_ID });
  expect(JSON.stringify(staged?.init?.body)).not.toContain('commit');
});

it('V-0199 the owner refusal and a refused call are printed as sentences with exit 1, and no other credential is tried', async () => {
  const w = world({ fail: { status: 403, code: 'owner_only' } });
  expect(await w.run('copy rules rm', { args: ['a1b2'], options: {} })).toBe(1);
  expect(w.calls).toHaveLength(1);
  expect(w.err.join('')).toContain('refused');
});

it('V-0199 a flag a verb does not take is refused before anything is asked of the daemon', async () => {
  const w = world();
  expect(await w.run('copy rules add', { args: [], options: { from: 'command:gh' } })).toBe(1);
  expect(await w.run('copy ls', { args: [], options: { nonsense: true } })).toBe(1);
  expect(w.calls).toEqual([]);
  expect(w.err.join('')).toContain("required option '--to' not specified");
});

it('V-0199 a ferret pane cannot run the owner commands, and nothing is asked of the daemon', async () => {
  process.env.FY_SESSION_ID = 's-in-a-pane';
  const w = world();
  expect(await w.run('plan ls', { args: [], options: {} })).toBe(1);
  expect(w.err.join('')).toContain(OWNER_COMMAND_REFUSAL);
  expect(w.calls).toEqual([]);
});

it('V-0351 plan approve staging never commits: the CLI has no commit route to call', async () => {
  const w = world();
  await w.run('plan approve', { args: ['feed', '1'], options: {} });
  expect(w.calls.map(call => call.route).some(route => route.endsWith('/commit'))).toBe(false);
});
