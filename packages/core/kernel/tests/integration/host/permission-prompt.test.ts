import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeAsks } from '../../../../asks/contract/testing/index.ts';
import { Runners } from '../../../../ferrets/contract/index.ts';
import { FakeRunner } from '../../../../ferrets/contract/testing/index.ts';
import { FakeGate, ownerStanding, StandInAdmission } from '../../../../gate/contract/testing/index.ts';
import { FakeVault } from '../../../../vault/contract/testing/index.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { daemonImplementations } from '../../../src/generated/plugins.ts';
import { type TestHost, testHost } from '../../../testing/index.ts';

/**
 * WHAT A FERRET IS STOPPED ON, through the daemon: the REAL Ferrets and the REAL Claude Code halves, as the generated
 * registry builds them. A runner whose look carries a permission prompt (the screen Ferrets' turn watch reads, parsed by
 * the runner into data) becomes the ferret's recorded request; `GET /v1/ferrets/:id/prompt` serves it (masked by Ferrets);
 * `POST /v1/ferrets/:id/permission` answers THAT request on the pane and nothing else. Fixture screens only.
 *
 * CI only (integration tier). Fixture values only.
 */

/** Ferrets' job that arms the turn watch (its contract does not export the id; the host lists it). */
const TURN_WATCH_JOB = 'ferrets.turn-watch';

const real = (id: string) => {
  const found = daemonImplementations.find(implementation => implementation.manifest.id === id);
  if (found === undefined) throw new Error(`the generated registry has no ${id} half`);
  return found;
};

const runnerPlugin = (runner: FakeRunner) =>
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
  );

/** The screen the pane shows, set by a test; `typed` is every tmux write the answer made. */
const machine = (screen: { frame: string }) => {
  const typed: string[][] = [];
  const done = (exitCode: number, stdout = '') => ({ exitCode, signal: null, stdout, stderr: '' });
  const spawn = async (program: string, args: readonly string[]) => {
    if (program === 'printenv') return done(0, '/home/kirin\n');
    if (program === 'uname') return done(0, 'Linux\n');
    if (program === 'which') return done(0, '/usr/local/bin/claude\n');
    if (program === 'tmux') {
      if (args[0] === 'capture-pane') return done(0, screen.frame);
      typed.push([...args]);
      // The key landed: the pane moves on to its prompt.
      screen.frame = IDLE;
      return done(0);
    }
    // `claude --version`: any claude this fixture machine is asked about starts.
    if (args[0] === '--version') return done(0, '2.1.281 (Claude Code)\n');
    return done(1);
  };
  return { typed, spawn };
};

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dir, '../../../../../plugins/claude-code/tests/fixtures', `${name}.txt`), 'utf8');

const SCREEN = fixture('permission-prompts/claude-2.1.281-read-outside');
const IDLE = '❯ \n  ? for shortcuts';

/**
 * What the runner's look reports for the permission screen: the request as data, exactly as the tmux runner parses this
 * fixture (its `harness` is spelled as Ferrets' state document spells it, `claude`, and its id digests that spelling).
 */
const REQUEST = {
  id: '15e254453e01352b',
  harness: 'claude',
  tool: 'Read',
  action: 'read',
  what: '/etc/hostname',
  question: 'Do you want to proceed?',
  options: [
    { number: 1, label: 'Yes', kind: 'allow' },
    { number: 2, label: 'Yes, allow reading from /etc during this session', kind: 'allow-always' },
    { number: 3, label: 'No', kind: 'deny' },
  ],
  selected: 1,
};

/**
 * The test host's in-memory roots name a scope's own folder with a trailing slash (`/agent-homes/<ferret>/`), which
 * Ferrets refuses as a home (a canonical home has none, as a real root names it). So the half sees the same roots with
 * that one spelling made canonical; everything else it asks of them is the host's own.
 */
const canonicalHomes = (claudeCode: ReturnType<typeof real>) =>
  ({
    ...claudeCode,
    build: (ctx: Parameters<NonNullable<typeof claudeCode.build>>[0]) => {
      const build = claudeCode.build;
      if (build === undefined) throw new Error('the claude-code daemon half has no build');
      const roots = {
        ...ctx.kernel.roots,
        root: (...args: Parameters<typeof ctx.kernel.roots.root>) => {
          const handle = ctx.kernel.roots.root(...args);
          return {
            ...handle,
            resolve: (relative: string) => {
              const resolved = handle.resolve(relative);
              return relative === '' && resolved.ok
                ? { ...resolved, value: String(resolved.value).replace(/\/+$/u, '') as never }
                : resolved;
            },
          };
        },
      };
      return build({ ...ctx, kernel: { ...ctx.kernel, roots } });
    },
  }) as typeof claudeCode;

async function boot(runner: FakeRunner, screen: { frame: string }): Promise<{ host: TestHost; typed: string[][] }> {
  const { typed, spawn } = machine(screen);
  const host = await testHost({
    plugins: [real('ferrets'), canonicalHomes(real('claude-code')), runnerPlugin(runner)],
    gate: new StandInAdmission(() => ownerStanding()),
    fakes: { gate: new FakeGate(), vault: new FakeVault(), asks: new FakeAsks() },
    spawn,
  });
  return { host, typed };
}

describe('a permission prompt on a ferret’s pane, through the real Ferrets and Claude Code', () => {
  test('the prompt route serves the recorded request, and the permission POST answers exactly that request', async () => {
    const runner = new FakeRunner();
    const screen = { frame: IDLE };
    const { host, typed } = await boot(runner, screen);
    const started = await host.request('POST', '/v1/ferrets', {
      headers: { 'x-fy-request-id': randomUUID() },
      body: { folder: '/work/a', prompt: 'Work.' },
    });
    if (started.status >= 300) throw new Error(started.body + JSON.stringify(host.logs));
    const id = started.json<{ id: string }>().id;
    await host.settle();

    // The turn watch is armed by its job (the daemon runs it once it serves).
    await host.runJob(TURN_WATCH_JOB);
    await host.settle();

    // Nothing is asked yet: the route answers an empty record.
    const before = await host.request('GET', `/v1/ferrets/${id}/prompt`);
    expect([before.status, before.json()]).toEqual([200, {}]);

    // The pane now shows a permission prompt; the turn watch records it.
    screen.frame = SCREEN;
    runner.screens.set('%1' as never, {
      frame: 'permission-1',
      working: false,
      atPrompt: false,
      permission: true,
      request: REQUEST,
    });
    // The turn watch looks on its own beat; step the driven clock until it has recorded what the pane shows.
    for (let beat = 0; beat < 30; beat += 1) {
      await host.clock.advance(2_000);
      await host.settle();
      const seen = await host.request('GET', `/v1/ferrets/${id}/prompt`);
      if (seen.json<{ turnState?: string }>().turnState !== undefined) break;
    }

    const asked = await host.request('GET', `/v1/ferrets/${id}/prompt`);
    expect(asked.status).toBe(200);
    expect(asked.json()).toMatchObject({ turnState: 'needs-input', permissionRequest: REQUEST });

    // Answering goes through the existing POST, with the id the card holds (the one Ferrets recorded).
    const posting = host.request('POST', `/v1/ferrets/${id}/permission`, {
      body: { kind: 'choice', requestId: REQUEST.id, number: 1 },
    });
    // The answer re-reads the pane on the daemon's clock; drive it until the answer is in.
    for (let beat = 0; beat < 5; beat += 1) {
      await host.clock.advance(200);
      await host.settle();
    }
    const answered = await posting;
    expect(answered.status).toBe(200);
    expect(answered.json()).toEqual({ requestId: REQUEST.id, cleared: true });
    // Exactly one key went to the pane: the digit of the choice, and nothing else.
    expect(typed.filter(args => args[0] === 'send-keys').map(args => args.at(-1))).toEqual(['1']);
  });

  test('an answer for another prompt than the one on the pane types nothing and says the prompt is gone', async () => {
    const runner = new FakeRunner();
    const screen = { frame: SCREEN };
    const { host, typed } = await boot(runner, screen);
    const started = await host.request('POST', '/v1/ferrets', {
      headers: { 'x-fy-request-id': randomUUID() },
      body: { folder: '/work/a', prompt: 'Work.' },
    });
    const id = started.json<{ id: string }>().id;
    await host.settle();

    const answered = await host.request('POST', `/v1/ferrets/${id}/permission`, {
      body: { kind: 'choice', requestId: 'ffffffffffffffff', number: 1 },
    });

    expect(answered.status).toBe(409);
    expect(answered.json<{ code: string }>().code).toBe('permission_prompt_gone');
    expect(typed.filter(args => args[0] === 'send-keys')).toEqual([]);
  });
});
