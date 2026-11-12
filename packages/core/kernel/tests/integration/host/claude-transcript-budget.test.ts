import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { fakeConversation } from '../../../../../plugins/conversation/contract/testing/index.ts';
import { fakeLogins, sampleLogin } from '../../../../../plugins/logins/contract/testing/index.ts';
import { FakeAsks } from '../../../../asks/contract/testing/index.ts';
import { RUNTIME_START_KEY, RuntimeStart, Logins, Runners } from '../../../../ferrets/contract/index.ts';
import { FakeLoginKind, FakeRunner, FakeRuntimeStart } from '../../../../ferrets/contract/testing/index.ts';
import { FakeGate, ownerStanding, StandInAdmission } from '../../../../gate/contract/testing/index.ts';
import { type SecretName } from '../../../../vault/contract/index.ts';
import { FakeVault } from '../../../../vault/contract/testing/index.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { daemonImplementations } from '../../../src/generated/plugins.ts';
import { testHost } from '../../../testing/index.ts';

/**
 * M4 / audit A fix 1, the plan's turn-budget case: the REAL Ferrets, the REAL Claude Code harness and the REAL Usage halves,
 * as the generated registry builds them, over a fixture Claude transcript in the ferret's own home. The transcript's
 * `usage` record (1200 input, 300 output tokens on a priced model) is read back by the harness, handed to Usage through
 * Ferrets' `turnUsage`, priced from the owner's catalog, and a daily budget below that figure TRIPS: the login is paused
 * and a new start on it is refused. Before the transcript exists the same budget is not reached, so the pause is the
 * transcript's doing. Fixture values only; no real credential, binary or owner state.
 */

const real = (id: string) => {
  const found = daemonImplementations.find(implementation => implementation.manifest.id === id);
  if (found === undefined) throw new Error(`the generated registry has no ${id} half`);
  return found;
};

const MODEL = 'claude-sonnet-4-5';
const FOLDER = '/work/project';
/** $3 per million input tokens, $15 per million output tokens, in USD micros per million tokens. */
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

const world = async () => {
  const runner = new FakeRunner();
  const vault = new FakeVault();
  await vault.put('LOGIN_WORK' as SecretName, 'fixture-not-a-credential');
  const host = await testHost({
    everyDirectory: true,
    plugins: [
      real('ferrets'),
      real('usage'),
      real('claude-code'),
      // The login kind that holds "work" (the real Logins half needs the machine's sign-in files; this is its provider only).
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
      // Runtimes' `runtime.start`: a start that names a login is checked there (a stand-in that lets every login through).
      implementDaemon(
        definePlugin({
          id: 'runtimes',
          title: 'Runtimes (fake)',
          version: '5.0.0',
          api: 5,
          core: false,
          kinds: [],
          hooks: { takes: [{ hook: RuntimeStart, key: RUNTIME_START_KEY }] },
        }),
        { build: () => ({ hooks: { 'runtime.start:runtimes': new FakeRuntimeStart() } }) },
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
    gate: new StandInAdmission(() => ownerStanding()),
    // A `claude` that answers `--version`, and the facts the harness asks the host for. Nothing real is started.
    spawn: (program, args) => {
      const done = (stdout: string) => ({ exitCode: 0, signal: null, stdout, stderr: '' });
      if (program === 'printenv') return done('/home/fixture\n');
      if (program === 'uname') return done('Linux\n');
      if (program === 'which') return done('/usr/local/bin/claude\n');
      if (args.includes('--version')) return done('2.1.220 (Claude Code)\n');
      return done('');
    },
    // A daily limit far below what the fixture transcript costs ($0.0036 + $0.0045 = $0.0081).
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
  return { host, runner };
};

test('M4 a Claude transcript with spend trips the daily budget; the same ferret with none does not', async () => {
  const { host } = await world();
  try {
    const started = await host.request('POST', '/v1/ferrets', {
      headers: { 'x-fy-request-id': randomUUID() },
      body: { folder: FOLDER, login: 'work' },
    });
    expect([started.status, started.body]).toEqual([201, expect.any(String)]);
    const { id } = started.json<{ id: string }>();

    // The real harness wrote the conversation binding at launch; the transcript is named by it, never found by guessing.
    const binding = JSON.parse(host.rootText('agent-homes', `${id}/conversation.json`) ?? '{}') as { id?: string };
    expect(typeof binding.id).toBe('string');

    // No transcript yet: nothing spent, so the budget is not reached (the baseline the trip is measured against).
    await host.runJob('usage-restore');
    await host.runJob('usage-budget');
    const before = (await host.request('GET', '/v1/usage/budgets')).json<{ budgets: { pause?: unknown }[] }>();
    expect(before.budgets).toHaveLength(1);
    expect(before.budgets[0]?.pause).toBeUndefined();

    // Claude writes its usage into the transcript; the same tick now measures it.
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
      `${id}/projects/-work-project/${binding.id}.jsonl`,
      `${record(1200, 100)}\n${record(0, 300)}\n`,
    );
    await host.runJob('usage-budget');

    const after = (await host.request('GET', '/v1/usage/budgets')).json<{
      budgets: {
        login: string;
        pause?: { pause: { level: string; period: string } };
        budget: { daily?: { spentUsd: number }; unpriced: number; measured: boolean };
      }[];
    }>();
    // The spend is the transcript's, priced: nonzero, nothing unpriced, and the meter has measured.
    expect(after.budgets[0]?.budget).toMatchObject({ unpriced: 0, measured: true });
    expect(after.budgets[0]?.budget.daily?.spentUsd).toBeGreaterThan(0.001);
    expect(after.budgets[0]?.pause?.pause).toMatchObject({ level: 'over_trigger', period: 'daily' });

    // The pause is acted on: a new start on that login is refused, naming the pause.
    const refused = await host.request('POST', '/v1/ferrets', {
      headers: { 'x-fy-request-id': randomUUID() },
      body: { folder: FOLDER, login: 'work' },
    });
    expect(refused.status).not.toBe(201);
    expect(refused.body).toContain('paused');
  } finally {
    await host.stop();
  }
});
