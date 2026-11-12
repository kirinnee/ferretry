import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { fakeConversation } from '../../../../../plugins/conversation/contract/testing/index.ts';
import { fakeLogins, sampleLogin } from '../../../../../plugins/logins/contract/testing/index.ts';
import { FakeAsks } from '../../../../asks/contract/testing/index.ts';
import { Logins, Runners, type FerretId } from '../../../../ferrets/contract/index.ts';
import { FakeLoginKind, FakeRunner } from '../../../../ferrets/contract/testing/index.ts';
import { FakeGate, ferretStanding, ownerStanding, StandInAdmission } from '../../../../gate/contract/testing/index.ts';
import { type SecretName } from '../../../../vault/contract/index.ts';
import { FakeVault } from '../../../../vault/contract/testing/index.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { daemonImplementations } from '../../../src/generated/plugins.ts';
import { testHost } from '../../../testing/index.ts';

/**
 * Audit A fix 2: `GET /v1/usage/budgets` through the daemon, the REAL Ferrets, Claude Code and Usage halves. Two unrelated
 * ferrets run on one budgeted login; only one of them spends (a priced Claude transcript). The owner still reads the
 * measured budget; a FERRET caller learns whether the login it uses is paused and nothing derived from another lineage's
 * spend: no spent amount, no unpriced count, no threshold level. The caller's standing is the stand-in's `ferretStanding`.
 */

const real = (id: string) => {
  const found = daemonImplementations.find(implementation => implementation.manifest.id === id);
  if (found === undefined) throw new Error(`the generated registry has no ${id} half`);
  return found;
};

const MODEL = 'claude-sonnet-4-5';
const FOLDER = '/work/project';
const RATE = {
  pricingKey: 'anthropic:claude-sonnet-4-5@2026-01-01',
  modelId: MODEL,
  aliases: [],
  provider: 'anthropic',
  currency: 'USD',
  rates: {
    input: 3_000_000,
    output: 15_000_000,
    cachedInput: 300_000,
    cacheWrite: 3_750_000,
    cacheWrite5m: null,
    cacheWrite1h: null,
    reasoning: null,
    image: null,
    tool: null,
  },
  source: { kind: 'manual' },
  validFrom: '2026-01-01T00:00:00.000Z',
  validThrough: null,
  verifiedAt: '2026-01-01T00:00:00.000Z',
  lastSyncedAt: null,
} as const;

const CALLER_HEADER = 'x-test-caller';

const world = async () => {
  const runner = new FakeRunner();
  const vault = new FakeVault();
  await vault.put('LOGIN_WORK' as SecretName, 'fixture-not-a-credential');
  const host = await testHost({
    plugins: [
      real('ferrets'),
      real('usage'),
      real('claude-code'),
      implementDaemon(
        definePlugin({
          id: 'logins',
          title: 'Logins (fake kind)',
          version: '5.0.0',
          api: 5,
          core: false,
          kinds: [],
          hooks: { takes: [{ hook: Logins, key: 'api-key' }] },
        }),
        { build: () => ({ hooks: { 'logins:api-key': new FakeLoginKind('api-key', ['work']) } }) },
      ),
      implementDaemon(
        definePlugin({
          id: 'terminals',
          title: 'Terminals (fake)',
          version: '5.0.0',
          api: 5,
          core: false,
          kinds: [],
          hooks: { takes: [{ hook: Runners, key: 'tmux' }] },
        }),
        { build: () => ({ hooks: { 'runners:tmux': runner } }) },
      ),
    ],
    gate: new StandInAdmission(request => {
      const caller = request.headers.get(CALLER_HEADER);
      return caller === null ? ownerStanding() : ferretStanding(caller as FerretId);
    }),
    spawn: (program, args) => {
      const done = (stdout: string) => ({ exitCode: 0, signal: null, stdout, stderr: '' });
      if (program === 'printenv') return done('/home/fixture\n');
      if (program === 'uname') return done('Linux\n');
      if (program === 'which') return done('/usr/local/bin/claude\n');
      if (args.includes('--version')) return done('2.1.220 (Claude Code)\n');
      return done('');
    },
    // A daily limit far below what the fixture transcript costs ($0.0081).
    config: { 'usage.yaml': { budgets: { work: { daily: { trigger: 0.001 } } } } },
    fakes: {
      gate: new FakeGate(),
      vault,
      asks: new FakeAsks(),
      conversation: fakeConversation(),
      logins: fakeLogins([sampleLogin('work')]),
    },
  });
  host.state('usage').files.set('pricing.json', JSON.stringify({ format: 1, catalog: [RATE], sources: [] }));
  return host;
};

const begin = async (host: Awaited<ReturnType<typeof world>>, login = 'work'): Promise<string> => {
  const started = await host.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': randomUUID() },
    body: { folder: FOLDER, login },
  });
  expect([started.status, started.body]).toEqual([201, expect.any(String)]);
  return started.json<{ id: string }>().id;
};

const spend = (host: Awaited<ReturnType<typeof world>>, ferret: string): void => {
  const binding = JSON.parse(host.rootText('agent-homes', `${ferret}/conversation.json`) ?? '{}') as { id?: string };
  const at = host.clock.now();
  const record = (inputTokens: number, outputTokens: number) =>
    JSON.stringify({
      type: 'assistant',
      uuid: randomUUID(),
      timestamp: at,
      message: {
        model: MODEL,
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      },
    });
  host.putRoot(
    'agent-homes',
    `${ferret}/projects/-work-project/${binding.id}.jsonl`,
    `${record(1200, 100)}\n${record(0, 300)}\n`,
  );
};

const budgetsAs = async (host: Awaited<ReturnType<typeof world>>, caller?: string) =>
  await host.request('GET', '/v1/usage/budgets', {
    ...(caller === undefined ? {} : { headers: { [CALLER_HEADER]: caller } }),
  });

test('audit A fix 2 a ferret reads whether its login is paused and nothing of another lineage spend; the owner keeps the figures', async () => {
  const host = await world();
  try {
    const victim = await begin(host);
    const outsider = await begin(host);
    await host.runJob('usage-restore');
    await host.runJob('usage-budget');
    spend(host, victim);
    await host.runJob('usage-budget');

    const owner = await budgetsAs(host);
    const measured = owner.json<{ budgets: { budget: { daily?: { spentUsd: number }; measured: boolean } }[] }>();
    expect(measured.budgets[0]?.budget.measured).toBe(true);
    expect(measured.budgets[0]?.budget.daily?.spentUsd).toBeGreaterThan(0.001);

    const seen = await budgetsAs(host, outsider);
    expect(seen.status).toBe(200);
    // The login the outsider uses is paused (a start on it would be refused); that is all it learns.
    expect(seen.json()).toEqual({ budgets: [{ login: 'work', paused: true }] });
    for (const leaked of ['spentUsd', 'unpriced', 'level', 'over_trigger', '0.0081', '0.01', 'measured'])
      expect(seen.body).not.toContain(leaked);
  } finally {
    await host.stop();
  }
});

test('audit A fix 2 a ferret sees only the logins its own lineage uses', async () => {
  const host = await world();
  try {
    const mine = await begin(host);
    const seen = await budgetsAs(host, mine);
    expect(seen.json()).toEqual({ budgets: [{ login: 'work', paused: false }] });
    const stranger = await budgetsAs(host, '00000000-0000-4000-8000-000000000999');
    expect(stranger.json()).toEqual({ budgets: [] });
  } finally {
    await host.stop();
  }
});
