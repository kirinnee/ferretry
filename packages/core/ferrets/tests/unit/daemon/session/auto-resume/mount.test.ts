/**
 * W2-a: auto-resume after a host restart, MOUNTED (today's `createAutoResume` + `BootExitRecorder`, `fyd.ts:8180`,
 * `:8388–8413`, `:13514–13522`, `:13727`). RULING #27 Q5: it fails closed — no answer of Runtimes' own is no resume
 * and nothing spent. "Spent" is a launch: `FakeRunner.starts`.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { milliseconds } from '@ferretry/std';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import type { TestHost } from '@ferretry/kernel/testing';
import {
  AutoResumeDecide,
  type AutoResumeDecideInput,
  AutoResumeFile,
  AutoResumeSummaryFile,
  FerretFiles,
  FerretHistoryFiles,
  type FerretId,
  FerretStateFile,
  FerretsPort,
  type FerretSummary,
  AGENT_ORIGIN,
  RUNTIME_START_KEY,
  RuntimeStart,
  StartDecide,
  type StartDecideInput,
} from '../../../../../contract/index.ts';
import { DECIDE_ASK_TIMEOUT_MS } from '../../../../../contract/hooks/decide-timeout.ts';
import { FakeHarness, FakeRunner } from '../../../../../contract/testing/index.ts';
import { AUTO_RESUME_JOB } from '../../../../../daemon/modules/auto-resume.ts';
import { TURN_WATCH_JOB } from '../../../../../daemon/features/turn-watch.feature.ts';
import { NO_AUTO_RESUME_ANSWER } from '../../../../../daemon/lib/ferrets/auto-resume.ts';
import { fakeLogins, fakeRuntimeStartAnswer, host, portConsumer } from '../../ferrets/route-fixture.ts';

type Plugins = NonNullable<NonNullable<Parameters<typeof host>[1]>['plugins']>;
type Answer = (input: AutoResumeDecideInput) => unknown;

/** A stand-in for Runtimes: its real manifest id, taking `auto-resume.decide`, recording every question. */
const fakeRuntimes = (answer: Answer, id = 'runtimes') => {
  const asked: AutoResumeDecideInput[] = [];
  const plugin = implementDaemon(
    definePlugin({
      id,
      title: `${id} (fake)`,
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: {
        takes: [
          { hook: AutoResumeDecide },
          // Only Runtimes' own id may take `runtime.start`; a stand-in under another id answers auto-resume alone.
          ...(id === 'runtimes' ? [{ hook: RuntimeStart, key: RUNTIME_START_KEY }] : []),
        ],
      },
    }),
    {
      build: () => ({
        hooks: {
          ...(id === 'runtimes' ? { 'runtime.start:runtimes': fakeRuntimeStartAnswer } : {}),
          'auto-resume.decide': async (input: AutoResumeDecideInput) => {
            asked.push(input);
            return (await answer(input)) as never;
          },
        },
      }),
    },
  );
  return { asked, plugin };
};
const yes: Answer = () => ({ allow: true });

/** Runtimes that answers a START (the runtime's login) and nothing about auto-resume: no answer of its own to that. */
const startOnlyRuntimes = () =>
  implementDaemon(
    definePlugin({
      id: 'runtimes',
      title: 'runtimes (start only) (fake)',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: { takes: [{ hook: RuntimeStart, key: RUNTIME_START_KEY }] },
    }),
    { build: () => ({ hooks: { 'runtime.start:runtimes': fakeRuntimeStartAnswer } }) },
  );

async function boot(plugins: Plugins) {
  const runner = new FakeRunner();
  const h = await host([], {
    harness: new FakeHarness(),
    runner,
    plugins: [...plugins, fakeLogins(), portConsumer('warden')],
  });
  return { h, runner };
}

const start = async (h: TestHost, name: string, mode?: 'interactive'): Promise<FerretId> => {
  const answer = await h.request('POST', '/v1/ferrets', {
    body: { name, folder: `/work/${name}`, runtime: 'claude-work', ...(mode === undefined ? {} : { mode }) },
    headers: { 'x-fy-request-id': randomUUID() },
  });
  expect(answer.status).toBe(201);
  return answer.json<{ id: FerretId }>().id;
};

const view = async (h: TestHost, id: FerretId) => (await h.request('GET', `/v1/ferrets/${id}`)).json<FerretSummary>();
const events = (h: TestHost, id: FerretId): readonly { type: string; data: Record<string, unknown> }[] =>
  (h.state('ferrets').raw(FerretHistoryFiles, id) ?? '')
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as { type: string; data: Record<string, unknown> });
const types = (h: TestHost, id: FerretId) => events(h, id).map(event => event.type);

/**
 * Moves the driven clock and lets what it woke run to its end. A launch now takes its conversation's lease on the real disk
 * (the lock file), which is not a microtask, so each turn waits a real millisecond.
 */
async function advance(h: TestHost, by: number): Promise<void> {
  await h.clock.advance(by);
  for (let turn = 0; turn < 40; turn += 1) {
    await h.clock.advance(0);
    await Bun.sleep(1);
  }
  await h.settle();
}

/** Runs the job to its end, moving the clock past every stagger and every decide bound it waits on. */
async function runPass(h: TestHost): Promise<void> {
  let done = false;
  const pass = h.runJob(AUTO_RESUME_JOB).finally(() => {
    done = true;
  });
  for (let step = 0; step < 60 && !done; step += 1) await advance(h, 1_000);
  await pass;
  await h.settle();
}

/** The host went down: every pane with it, then the daemon came back on the same state. */
async function hostRestart(h: TestHost, runner: FakeRunner): Promise<TestHost> {
  await h.settle();
  runner.reboot();
  return await h.restart();
}

describe('W2-a auto-resume, mounted', () => {
  test('W2-a brings back every ferret a host restart took down, through the ordinary resume, after the daemon serves', async () => {
    const runtimes = fakeRuntimes(yes);
    let { h, runner } = await boot([runtimes.plugin]);
    const a = await start(h, 'alder');
    const b = await start(h, 'birch');
    const launches = runner.starts;
    h = await hostRestart(h, runner);
    expect(runner.starts).toBe(launches);

    await runPass(h);

    expect(runner.starts).toBe(launches + 2);
    for (const id of [a, b]) {
      expect((await view(h, id)).state).not.toBe('stopped');
      expect(types(h, id)).toContain('session.exited');
      expect(types(h, id)).toContain('session.auto_resumed');
      expect(events(h, id).find(event => event.type === 'session.resumed')?.data.automatic).toBe(true);
    }
    expect(runtimes.asked[0]).toEqual({ ask: 'switch' });
    expect(
      runtimes.asked
        .filter(input => input.ask === 'runtime')
        .map(input => input.ferret)
        .sort(),
    ).toEqual([a, b].sort());
    await h.stop();
  });

  test('FX3: a converted ferret with NO handle (working, and idle) is settled terminal_gone and auto-resumed like any other', async () => {
    let { h, runner } = await boot([fakeRuntimes(yes).plugin]);
    const working = await start(h, 'fir');
    const idle = await start(h, 'gingko');
    await h.settle();
    // The converter drops a handle it cannot prove: both records stay live in the registry, with no handle and no pane.
    for (const [id, state] of [
      [working, 'working'],
      [idle, 'idle'],
    ] as const) {
      const document = JSON.parse(h.state('ferrets').raw(FerretFiles, id) ?? '{}') as Record<string, unknown>;
      delete document.handle;
      h.state('ferrets').plant(FerretFiles, JSON.stringify({ ...document, state }), id);
    }
    const launches = runner.starts;
    h = await hostRestart(h, runner);
    expect(runner.starts).toBe(launches);

    await runPass(h);

    expect(runner.starts).toBe(launches + 2);
    for (const id of [working, idle]) {
      expect((await view(h, id)).state).not.toBe('stopped');
      expect(types(h, id)).toContain('session.exited');
      expect(types(h, id)).toContain('session.auto_resumed');
    }
    await h.stop();
  });

  test('W2-a a ferret that was mid-turn when the host went down is told so on its way back, in either mode', async () => {
    let { h, runner } = await boot([fakeRuntimes(yes).plugin]);
    const auto = await start(h, 'cedar');
    const chat = await start(h, 'dogwood', 'interactive');
    h = await hostRestart(h, runner);
    await runPass(h);
    const resumed = (id: FerretId) => events(h, id).find(event => event.type === 'session.auto_resumed')?.data;
    expect(resumed(auto)?.notified).toBe(true);
    expect(resumed(chat)?.notified).toBe(true);
    await h.stop();
  });

  describe("fails closed: no answer of Runtimes' own is no resume and nothing spent (RULING #27 Q5)", () => {
    const cases: readonly [string, Plugins][] = [
      ['no auto-resume answer from Runtimes', [startOnlyRuntimes()]],
      ['Runtimes throws', [fakeRuntimes(() => Promise.reject(new Error('sk-live-nope'))).plugin]],
      ['Runtimes hangs past the kernel bound', [fakeRuntimes(() => new Promise(() => undefined)).plugin]],
      ['Runtimes answers garbage (a string)', [fakeRuntimes(() => 'yes').plugin]],
      ['Runtimes answers garbage (allow: "true")', [fakeRuntimes(() => ({ allow: 'true' })).plugin]],
      ['Runtimes answers garbage (null)', [fakeRuntimes(() => null).plugin]],
      ['Runtimes answers allow: false', [fakeRuntimes(() => ({ allow: false, reason: 'off' })).plugin]],
      ['only another plugin says yes', [startOnlyRuntimes(), fakeRuntimes(yes, 'usage').plugin]],
    ];
    for (const [name, plugins] of cases)
      test(`W2-a the switch: ${name} → nothing resumed, nothing launched, the ledger forgotten`, async () => {
        let { h, runner } = await boot(plugins);
        const id = await start(h, 'elm');
        const launches = runner.starts;
        h = await hostRestart(h, runner);
        await runPass(h);
        expect(runner.starts).toBe(launches);
        const after = await view(h, id);
        expect(after.state).toBe('stopped');
        expect(after.cause).toEqual({ kind: 'terminal_gone' });
        expect(types(h, id)).not.toContain('session.auto_resumed');
        expect(h.state('ferrets').raw(AutoResumeFile)).toBeUndefined();
        expect(h.state('ferrets').raw(AutoResumeSummaryFile)).toBeUndefined();
        await h.stop();
      });

    const perFerret: readonly [string, Answer][] = [
      ['throws', () => Promise.reject(new Error('sk-live-nope'))],
      ['hangs past the kernel bound', () => new Promise(() => undefined)],
      ['answers garbage', () => ({ allow: 1 })],
      ['answers allow: false', () => ({ allow: false, reason: 'Login claude-work needs sign-in' })],
    ];
    for (const [name, answer] of perFerret)
      test(`W2-a the runtime: Runtimes ${name} → that ferret is skipped with why, nothing launched`, async () => {
        const runtimes = fakeRuntimes(input => (input.ask === 'switch' ? { allow: true } : answer(input)));
        let { h, runner } = await boot([runtimes.plugin]);
        const id = await start(h, 'fir');
        const launches = runner.starts;
        h = await hostRestart(h, runner);
        await runPass(h);
        expect(runner.starts).toBe(launches);
        expect((await view(h, id)).state).toBe('stopped');
        const skipped = events(h, id).find(event => event.type === 'session.auto_resume_skipped');
        expect(skipped).toBeDefined();
        const summary = JSON.parse(h.state('ferrets').raw(AutoResumeSummaryFile) ?? '{}') as {
          resumed: number;
          skipped: { sessionId: string; reason: string }[];
        };
        expect(summary.resumed).toBe(0);
        expect(summary.skipped.map(entry => entry.sessionId)).toEqual([id]);
        // A throw's message is never served: only Runtimes' own refusal sentence is kept.
        expect(JSON.stringify(summary)).not.toContain('sk-live-nope');
        if (name === 'answers allow: false') expect(summary.skipped[0]?.reason).toBe('Login claude-work needs sign-in');
        else expect(summary.skipped[0]?.reason).toBe(NO_AUTO_RESUME_ANSWER);
        await h.stop();
      });
  });

  test('W2-a a ferret the owner stopped before the restart stays stopped', async () => {
    const runtimes = fakeRuntimes(yes);
    let { h, runner } = await boot([runtimes.plugin]);
    const stopped = await start(h, 'gum');
    const live = await start(h, 'hazel');
    expect((await h.request('POST', `/v1/ferrets/${stopped}/stop`)).status).toBe(200);
    h = await hostRestart(h, runner);
    const launches = runner.starts;
    await runPass(h);
    expect(runner.starts).toBe(launches + 1);
    expect((await view(h, stopped)).state).toBe('stopped');
    expect((await view(h, stopped)).cause).toEqual({ kind: 'stopped' });
    expect(types(h, stopped)).not.toContain('session.exited');
    expect((await view(h, live)).state).not.toBe('stopped');
    await h.stop();
  });

  test('W2-a a person who resumes the ferret first wins: the pass launches no second pane', async () => {
    let h!: TestHost;
    let id!: FerretId;
    const runtimes = fakeRuntimes(async input => {
      // The owner resumes it while the pass is asking whether it may: by the time the pass resumes, it is not owed.
      if (input.ask === 'runtime')
        expect((await h.request('POST', `/v1/ferrets/${id}/resume`, { body: {} })).status).toBe(200);
      return { allow: true };
    });
    const booted = await boot([runtimes.plugin]);
    h = booted.h;
    id = await start(h, 'ivy');
    h = await hostRestart(h, booted.runner);
    const launches = booted.runner.starts;
    await runPass(h);
    expect(booted.runner.starts).toBe(launches + 1);
    // The pass stood down: no "skipped" line on a ferret that is up, and nothing claims the pass resumed it.
    expect(types(h, id)).not.toContain('session.auto_resume_skipped');
    expect(types(h, id)).not.toContain('session.auto_resumed');
    expect(h.state('ferrets').raw(AutoResumeSummaryFile)).toBeUndefined();
    await h.stop();
  });

  test('W2-a a ferret relaunched on another pane while the boot pass looks is not settled (the settle compares the handle)', async () => {
    /** A runner whose first `gone` lets the owner stop and resume the ferret before it answers "gone" for the OLD pane. */
    class RacingRunner extends FakeRunner {
      race: (() => Promise<void>) | undefined;
      override async gone(ferret: FerretId): Promise<boolean> {
        const race = this.race;
        this.race = undefined;
        if (race === undefined) return await super.gone(ferret);
        await race();
        return true;
      }
    }
    const runner = new RacingRunner();
    let h = await host([], { harness: new FakeHarness(), runner, plugins: [fakeRuntimes(yes).plugin, fakeLogins()] });
    const id = await start(h, 'tamarack');
    h = await hostRestart(h, runner);
    const launches = runner.starts;
    runner.race = async () => {
      expect((await h.request('POST', `/v1/ferrets/${id}/stop`)).status).toBe(200);
      expect((await h.request('POST', `/v1/ferrets/${id}/resume`, { body: {} })).status).toBe(200);
    };
    await runPass(h);
    expect(runner.starts).toBe(launches + 1);
    expect((await view(h, id)).state).not.toBe('stopped');
    expect(types(h, id)).not.toContain('session.exited');
    expect(types(h, id)).not.toContain('session.auto_resumed');
    await h.stop();
  });

  test('W2-a restart idempotent: a second boot resumes nothing again', async () => {
    let { h, runner } = await boot([fakeRuntimes(yes).plugin]);
    const id = await start(h, 'juniper');
    h = await hostRestart(h, runner);
    await runPass(h);
    const launches = runner.starts;
    const before = types(h, id).length;
    // The daemon restarts (not the host): the resumed pane is still there.
    h = await h.restart();
    await runPass(h);
    expect(runner.starts).toBe(launches);
    expect(types(h, id).length).toBe(before);
    await h.stop();
  });

  test('W2-a a ferret whose resume failed is not tried again by the next boot (no storm)', async () => {
    const runtimes = fakeRuntimes(input => (input.ask === 'switch' ? { allow: true } : { allow: false, reason: 'no' }));
    let { h, runner } = await boot([runtimes.plugin]);
    const id = await start(h, 'kauri');
    const launches = runner.starts;
    h = await hostRestart(h, runner);
    await runPass(h);
    for (let crash = 0; crash < 3; crash += 1) {
      h = await hostRestart(h, runner);
      await runPass(h);
    }
    expect(runner.starts).toBe(launches);
    expect(types(h, id).filter(type => type === 'session.auto_resume_skipped')).toHaveLength(1);
    await h.stop();
  });

  test('W2-a a daemon crash loop (tmux still up) resumes nothing', async () => {
    const runtimes = fakeRuntimes(yes);
    let { h, runner } = await boot([runtimes.plugin]);
    const id = await start(h, 'larch');
    const launches = runner.starts;
    for (let crash = 0; crash < 3; crash += 1) {
      h = await h.restart();
      await runPass(h);
    }
    expect(runner.starts).toBe(launches);
    expect((await view(h, id)).state).not.toBe('stopped');
    expect(types(h, id)).not.toContain('session.exited');
    await h.stop();
  });

  test("W2-a never more than today's cap: one revive at once, the next only after the 4 s stagger", async () => {
    let { h, runner } = await boot([fakeRuntimes(yes).plugin]);
    for (const name of ['maple', 'oak', 'pine']) await start(h, name);
    h = await hostRestart(h, runner);
    const launches = runner.starts;
    const pass = h.runJob(AUTO_RESUME_JOB);
    await advance(h, 0);
    expect(runner.starts).toBe(launches + 1);
    await advance(h, 3_999);
    expect(runner.starts).toBe(launches + 1);
    await advance(h, 1);
    expect(runner.starts).toBe(launches + 3);
    await pass;
    await h.stop();
  });

  test('W2-a no runner proof (a runner without `gone`, or one that cannot ask) settles nothing', async () => {
    let { h, runner } = await boot([fakeRuntimes(yes).plugin]);
    const id = await start(h, 'spruce');
    const launches = runner.starts;
    runner.goneAnswer = 'throw';
    h = await hostRestart(h, runner);
    await runPass(h);
    expect(runner.starts).toBe(launches);
    expect((await view(h, id)).state).not.toBe('stopped');
    expect(types(h, id)).not.toContain('session.exited');
    runner.goneAnswer = false;
    h = await h.restart();
    await runPass(h);
    expect(runner.starts).toBe(launches);
    expect(types(h, id)).not.toContain('session.exited');
    await h.stop();
  });
  describe("a stop of a ferret the boot pass settled is the stopper's decision: nothing resumes it against them", () => {
    for (const how of ['polite', 'now'] as const)
      test(`W2-a an owner's ${how} Stop of a settled ferret while the pass still staggers wins: it is never launched`, async () => {
        let { h, runner } = await boot([fakeRuntimes(yes).plugin]);
        const ids = [await start(h, 'acacia'), await start(h, 'baobab'), await start(h, 'catalpa')];
        h = await hostRestart(h, runner);
        const launches = runner.starts;
        const pass = h.runJob(AUTO_RESUME_JOB);
        await advance(h, 0);
        expect(runner.starts).toBe(launches + 1);
        // The two the cap holds back are settled and owed; the owner stops them before the 4 s stagger runs out.
        const waiting: FerretId[] = [];
        for (const id of ids) if ((await view(h, id)).cause?.kind === 'terminal_gone') waiting.push(id);
        expect(waiting).toHaveLength(2);
        for (const id of waiting)
          expect((await h.request('POST', `/v1/ferrets/${id}/stop`, { query: { how } })).status).toBe(200);
        for (let step = 0; step < 20; step += 1) await advance(h, 1_000);
        await pass;
        expect(runner.starts).toBe(launches + 1);
        for (const id of waiting) {
          expect((await view(h, id)).state).toBe('stopped');
          expect((await view(h, id)).cause).toEqual({ kind: 'stopped' });
          expect(types(h, id)).not.toContain('session.auto_resumed');
          expect(types(h, id)).toContain('session.stopped');
        }
        await h.stop();
      });

    const stoppers: readonly [string, (h: TestHost, id: FerretId) => Promise<void>][] = [
      [
        'the owner (the route)',
        async (h, id) => expect((await h.request('POST', `/v1/ferrets/${id}/stop`)).status).toBe(200),
      ],
      [
        "another plugin (Ferrets' port: the Warden, a budget)",
        async (h, id) => await h.provided(FerretsPort).stop(id, 'polite'),
      ],
    ];
    for (const [who, stop] of stoppers)
      test(`W2-a F-0109 a stop by ${who} wins over the ledger that outlived a crash mid-pass, on the next boot`, async () => {
        let h!: TestHost;
        let on = false;
        let ledger: string | undefined;
        const runtimes = fakeRuntimes(input => {
          if (input.ask !== 'switch') return { allow: true };
          // What the pass wrote down before it asked anything: the ledger a crash from here on leaves behind.
          ledger ??= h.state('ferrets').raw(AutoResumeFile);
          return on ? { allow: true } : { allow: false, reason: 'off' };
        });
        const booted = await boot([runtimes.plugin]);
        h = booted.h;
        const halted = await start(h, 'quince');
        const owed = await start(h, 'rowan');
        h = await hostRestart(h, booted.runner);
        await runPass(h);
        expect(ledger).toContain(halted);
        expect(ledger).toContain(owed);
        // The daemon died mid-pass: every ferret it settled is still on the ledger, still `terminal_gone`.
        h.state('ferrets').plant(AutoResumeFile, ledger as string);
        expect((await view(h, halted)).cause).toEqual({ kind: 'terminal_gone' });
        await stop(h, halted);
        expect((await view(h, halted)).cause).toEqual({ kind: 'stopped' });
        on = true;
        h = await h.restart();
        const launches = booted.runner.starts;
        await runPass(h);
        // The ledger was live (the ferret nobody stopped came back); the stopped one was not resumed against the stop.
        expect(booted.runner.starts).toBe(launches + 1);
        expect((await view(h, owed)).state).not.toBe('stopped');
        expect((await view(h, halted)).state).toBe('stopped');
        expect((await view(h, halted)).cause).toEqual({ kind: 'stopped' });
        expect(types(h, halted)).not.toContain('session.auto_resumed');
        expect(h.state('ferrets').raw(AutoResumeFile) ?? '').not.toContain(halted);
        await h.stop();
      });
  });

  test("W2-a why a resume was refused is kept bounded (200 characters), as Runtimes' own refusal is", async () => {
    const refusal = `${'a start.decide taker refused this resume '.repeat(20)}sk-live-tail`;
    const taker = implementDaemon(
      definePlugin({
        id: 'packs',
        title: 'packs (fake)',
        version: '5.0.0',
        api: 5,
        core: false,
        kinds: [],
        hooks: { takes: [{ hook: StartDecide }] },
      }),
      {
        build: () => ({
          hooks: {
            'start.decide': async (input: StartDecideInput) =>
              (input.by === 'resume' ? { allow: false, reason: refusal } : { allow: true }) as never,
          },
        }),
      },
    );
    let { h, runner } = await boot([fakeRuntimes(yes).plugin, taker as never]);
    const id = await start(h, 'sumac');
    h = await hostRestart(h, runner);
    await runPass(h);
    const summary = JSON.parse(h.state('ferrets').raw(AutoResumeSummaryFile) ?? '{}') as {
      skipped: { sessionId: string; reason: string }[];
    };
    expect(summary.skipped.map(entry => entry.sessionId)).toEqual([id]);
    expect(summary.skipped[0]?.reason).toBe(refusal.slice(0, 200));
    const skipped = events(h, id).find(event => event.type === 'session.auto_resume_skipped');
    expect(JSON.stringify(skipped)).not.toContain('sk-live-tail');
    await h.stop();
  });

  describe('fails closed, per question and per pass', () => {
    /** Runtimes whose per-ferret answer (a yes) takes `delayMs` of the kernel's virtual clock: no real waiting. */
    const slowRuntimes = (delayMs: number) =>
      implementDaemon(
        definePlugin({
          id: 'runtimes',
          title: 'runtimes (fake)',
          version: '5.0.0',
          api: 5,
          core: false,
          kinds: [],
          hooks: { takes: [{ hook: AutoResumeDecide }, { hook: RuntimeStart, key: RUNTIME_START_KEY }] },
        }),
        {
          build: ctx => ({
            hooks: {
              'runtime.start:runtimes': fakeRuntimeStartAnswer,
              'auto-resume.decide': async (input: AutoResumeDecideInput) => {
                if (input.ask === 'runtime') await ctx.kernel.clock.sleep(milliseconds(delayMs));
                return { allow: true } as never;
              },
            },
          }),
        },
      );

    test('W2-a a SLOW yes (1 s, a loaded host reading files) still resumes: the bound is the start.decide bound, not 200 ms', async () => {
      let { h, runner } = await boot([slowRuntimes(1_000) as never]);
      const id = await start(h, 'sycamore');
      const launches = runner.starts;
      h = await hostRestart(h, runner);
      await runPass(h);
      expect(runner.starts).toBe(launches + 1);
      expect((await view(h, id)).state).not.toBe('stopped');
      expect(types(h, id)).toContain('session.auto_resumed');
      await h.stop();
    });

    test('W2-a the decide bound is the shared start.decide bound', () => {
      expect(AutoResumeDecide.timeoutMs).toBe(DECIDE_ASK_TIMEOUT_MS);
    });

    // The bound is wound on the kernel's virtual clock (the test host races it with its real timer), so a yes past it
    // costs no real wait.
    test('W2-a a LATE yes (past the decide bound, on the kernel clock) resumes nothing', async () => {
      let { h, runner } = await boot([slowRuntimes(DECIDE_ASK_TIMEOUT_MS + 1_000) as never]);
      const id = await start(h, 'tupelo');
      const launches = runner.starts;
      h = await hostRestart(h, runner);
      await runPass(h);
      await advance(h, 1_000);
      expect(runner.starts).toBe(launches);
      expect((await view(h, id)).state).toBe('stopped');
      const summary = JSON.parse(h.state('ferrets').raw(AutoResumeSummaryFile) ?? '{}') as {
        skipped: { reason: string }[];
      };
      expect(summary.skipped[0]?.reason).toBe(NO_AUTO_RESUME_ANSWER);
      await h.stop();
    });

    test('W2-a the runtime is asked per ferret: a yes for one and a no for the other resumes only the one', async () => {
      let allowed: FerretId | undefined;
      const runtimes = fakeRuntimes(input =>
        input.ask === 'switch' || input.ferret === allowed ? { allow: true } : { allow: false, reason: 'not this one' },
      );
      let { h, runner } = await boot([runtimes.plugin]);
      const a = await start(h, 'ulmus');
      const b = await start(h, 'viburnum');
      allowed = a;
      const launches = runner.starts;
      h = await hostRestart(h, runner);
      await runPass(h);
      expect(runner.starts).toBe(launches + 1);
      expect((await view(h, a)).state).not.toBe('stopped');
      expect((await view(h, b)).state).toBe('stopped');
      expect(types(h, b)).toContain('session.auto_resume_skipped');
      await h.stop();
    });

    test('W2-a the switch is asked again on every pass: on for one reboot, off for the next resumes nothing', async () => {
      let on = true;
      const runtimes = fakeRuntimes(input =>
        input.ask === 'switch' ? (on ? { allow: true } : { allow: false, reason: 'off' }) : { allow: true },
      );
      let { h, runner } = await boot([runtimes.plugin]);
      const id = await start(h, 'willow');
      h = await hostRestart(h, runner);
      await runPass(h);
      expect((await view(h, id)).state).not.toBe('stopped');
      const launches = runner.starts;
      on = false;
      h = await hostRestart(h, runner);
      await runPass(h);
      expect(runner.starts).toBe(launches);
      expect((await view(h, id)).state).toBe('stopped');
      expect(runtimes.asked.filter(input => input.ask === 'switch')).toHaveLength(2);
      await h.stop();
    });
  });

  describe('W3: the gaps converted ferrets and the other revive paths left', () => {
    /** The session document's status, as a converted v4 ferret still holds it (what the boot pass reads). */
    const holdStatus = (h: TestHost, id: FerretId, status: string, quota?: Record<string, unknown>): void => {
      const document = JSON.parse(h.state('ferrets').raw(FerretStateFile, id) ?? '{}') as Record<string, unknown>;
      h.state('ferrets').plant(
        FerretStateFile,
        JSON.stringify({ ...document, status, ...(quota === undefined ? {} : { quota }) }),
        id,
      );
    };
    /** A converted v4 ferret: live in the registry (`state`), with no handle. */
    const dropHandle = async (h: TestHost, id: FerretId, state: 'working' | 'idle'): Promise<void> => {
      await h.settle();
      const document = JSON.parse(h.state('ferrets').raw(FerretFiles, id) ?? '{}') as Record<string, unknown>;
      delete document.handle;
      h.state('ferrets').plant(FerretFiles, JSON.stringify({ ...document, state }), id);
    };
    const PAST = 1;
    const FUTURE = 4_102_444_800_000;
    /** The Warden's revive, as it makes it through Ferrets' port (`remedies.resume`). */
    const wardenRevive = async (h: TestHost, id: FerretId) =>
      await h.provided(FerretsPort, 'warden').resume(id, 'Ferretry started your terminal again.', {
        origin: AGENT_ORIGIN,
        automatic: true,
        actor: 'warden',
      });
    const summaryOf = (h: TestHost) =>
      JSON.parse(h.state('ferrets').raw(AutoResumeSummaryFile) ?? 'null') as {
        resumed: number;
        skipped: { sessionId: string; reason: string }[];
      } | null;

    for (const [status, quota] of [
      ['rate_limited', { atLimit: true, retryAt: PAST }],
      ['retrying', undefined],
    ] as const)
      test(`W3-1 a converted ferret parked on ${status} (reset time past, where it has one) is settled terminal_gone at boot and auto-resumed, no handle needed`, async () => {
        let { h, runner } = await boot([fakeRuntimes(yes).plugin]);
        const id = await start(h, 'sumac');
        await dropHandle(h, id, 'working');
        holdStatus(h, id, status, quota);
        const launches = runner.starts;
        h = await hostRestart(h, runner);
        expect(runner.starts).toBe(launches);

        await runPass(h);

        expect(runner.starts).toBe(launches + 1);
        expect((await view(h, id)).state).not.toBe('stopped');
        expect(types(h, id)).toContain('session.exited');
        expect(events(h, id).find(event => event.type === 'session.exited')?.data.from).toBe(status);
        expect(types(h, id)).toContain('session.auto_resumed');
        await h.stop();
      });

    for (const [name, quota] of [
      ['its reset time is still ahead', { atLimit: true, retryAt: FUTURE }],
      ['it is at its limit with no reset time', { atLimit: true }],
    ] as const)
      test(`FX-W3-1 a rate_limited ferret is NOT resumed at boot while ${name}: nothing observed, settled or launched`, async () => {
        let { h, runner } = await boot([fakeRuntimes(yes).plugin]);
        const id = await start(h, 'sumac');
        await dropHandle(h, id, 'working');
        holdStatus(h, id, 'rate_limited', quota);
        const launches = runner.starts;
        h = await hostRestart(h, runner);

        await runPass(h);

        expect(runner.starts).toBe(launches);
        expect(types(h, id)).not.toContain('session.exited');
        expect(types(h, id)).not.toContain('session.auto_resumed');
        expect(types(h, id)).not.toContain('session.auto_resume_skipped');
        expect(h.state('ferrets').raw(AutoResumeFile)).toBeUndefined();
        await h.stop();
      });

    test('W3-1 a ferret whose stop was never confirmed (kill_failed) is settled at boot and then refused plainly, never launched', async () => {
      let { h, runner } = await boot([fakeRuntimes(yes).plugin]);
      const id = await start(h, 'tupelo');
      await h.settle();
      holdStatus(h, id, 'kill_failed');
      const launches = runner.starts;
      h = await hostRestart(h, runner);

      await runPass(h);

      expect(runner.starts).toBe(launches);
      expect((await view(h, id)).state).toBe('stopped');
      expect((await view(h, id)).cause).toEqual({ kind: 'terminal_gone' });
      expect(summaryOf(h)?.skipped.map(entry => entry.sessionId)).toEqual([id]);
      expect(summaryOf(h)?.skipped[0]?.reason).toContain('was not confirmed');
      await h.stop();
    });

    test('W3-3 the sweep settling a ferret BEFORE the boot pass looks: the pass still resumes it, once', async () => {
      let { h, runner } = await boot([fakeRuntimes(yes).plugin]);
      const id = await start(h, 'ulmus');
      const launches = runner.starts;
      h = await hostRestart(h, runner);
      // The turn watch is armed (its first look and its 30 s sweep) and settles the vanished pane before the pass runs.
      await h.runJob(TURN_WATCH_JOB);
      await advance(h, 30_000);
      expect((await view(h, id)).state).toBe('stopped');
      expect((await view(h, id)).cause).toEqual({ kind: 'terminal_gone' });
      expect(runner.starts).toBe(launches);

      await runPass(h);

      expect(runner.starts).toBe(launches + 1);
      expect((await view(h, id)).state).not.toBe('stopped');
      expect(types(h, id)).toContain('session.auto_resumed');
      expect(types(h, id).filter(type => type === 'session.exited')).toHaveLength(1);
      await h.stop();
    });

    test('FX-W3-2 the sweep settling a ferret whose document says completed (the registry still said working) owes it NO resume', async () => {
      let { h, runner } = await boot([fakeRuntimes(yes).plugin]);
      const id = await start(h, 'zelkova');
      await h.settle();
      holdStatus(h, id, 'completed');
      const launches = runner.starts;
      h = await hostRestart(h, runner);
      await h.runJob(TURN_WATCH_JOB);
      await advance(h, 30_000);
      expect((await view(h, id)).state).toBe('stopped');
      expect((await view(h, id)).cause).toEqual({ kind: 'terminal_gone' });

      await runPass(h);

      expect(runner.starts).toBe(launches);
      expect(types(h, id)).not.toContain('session.auto_resumed');
      expect(types(h, id)).not.toContain('session.auto_resume_skipped');
      expect(h.state('ferrets').raw(AutoResumeFile)).toBeUndefined();
      await h.stop();
    });

    test('FX-W3-2 a sweep-settled ferret whose rate_limited document is still limited is owed no resume either', async () => {
      let { h, runner } = await boot([fakeRuntimes(yes).plugin]);
      const id = await start(h, 'zelkova');
      await h.settle();
      holdStatus(h, id, 'rate_limited', { atLimit: true, retryAt: FUTURE });
      const launches = runner.starts;
      h = await hostRestart(h, runner);
      await h.runJob(TURN_WATCH_JOB);
      await advance(h, 30_000);
      expect((await view(h, id)).state).toBe('stopped');

      await runPass(h);

      expect(runner.starts).toBe(launches);
      expect(types(h, id)).not.toContain('session.auto_resumed');
      await h.stop();
    });

    test('FX-W3-4 an IDLE ferret the sweep settled first is resumed without the mid-turn notice (as the boot pass does); a working one gets it', async () => {
      let { h, runner } = await boot([fakeRuntimes(yes).plugin]);
      const idle = await start(h, 'alnus', 'interactive');
      const working = await start(h, 'betula', 'interactive');
      await h.settle();
      const document = JSON.parse(h.state('ferrets').raw(FerretFiles, idle) ?? '{}') as Record<string, unknown>;
      h.state('ferrets').plant(FerretFiles, JSON.stringify({ ...document, state: 'idle' }), idle);
      const launches = runner.starts;
      h = await hostRestart(h, runner);
      await h.runJob(TURN_WATCH_JOB);
      await advance(h, 30_000);
      expect((await view(h, idle)).cause).toEqual({ kind: 'terminal_gone' });
      expect((await view(h, working)).cause).toEqual({ kind: 'terminal_gone' });

      await runPass(h);

      expect(runner.starts).toBe(launches + 2);
      const resumed = (id: FerretId) => events(h, id).find(event => event.type === 'session.auto_resumed')?.data;
      expect(resumed(idle)?.notified).toBe(false);
      expect(resumed(working)?.notified).toBe(true);
      await h.stop();
    });

    test('W3-3 a ferret that vanished long after boot (a crash an hour in) is NOT owed a resume by the next pass', async () => {
      let { h, runner } = await boot([fakeRuntimes(yes).plugin]);
      const id = await start(h, 'viburnum');
      h = await hostRestart(h, runner);
      // The pass of this boot ran with nothing to settle (the pane was still there: the daemon restarted, not the host).
      runner.reboot();
      await h.runJob(TURN_WATCH_JOB);
      await advance(h, 30_000);
      expect((await view(h, id)).cause).toEqual({ kind: 'terminal_gone' });
      const launches = runner.starts;
      // A ledger-less pass from an earlier boot's records: only a settle of THIS process counts.
      h = await h.restart();
      await runPass(h);
      expect(runner.starts).toBe(launches);
      expect((await view(h, id)).state).toBe('stopped');
      await h.stop();
    });

    test('W3-2 the pass, the sweep and the Warden revive over the same ferret: ONE launch, and the pass says nothing confusing', async () => {
      let h!: TestHost;
      let id!: FerretId;
      let revived: Awaited<ReturnType<typeof wardenRevive>> | undefined;
      const runtimes = fakeRuntimes(async input => {
        // The Warden's revive reads the settled ferret as failed and brings it back while the pass asks Runtimes.
        if (input.ask === 'runtime') revived = await wardenRevive(h, id);
        return { allow: true };
      });
      const booted = await boot([runtimes.plugin]);
      h = booted.h;
      id = await start(h, 'wisteria');
      h = await hostRestart(h, booted.runner);
      const launches = booted.runner.starts;
      await h.runJob(TURN_WATCH_JOB);

      await runPass(h);
      // Everything keeps running over the revived ferret: the sweep's next looks, a second Warden revive, a second pass.
      await advance(h, 60_000);
      const again = await wardenRevive(h, id);
      await runPass(h);

      expect(revived).toMatchObject({ ok: true });
      expect(again).toMatchObject({ ok: true });
      expect(booted.runner.starts).toBe(launches + 1);
      expect((await view(h, id)).state).not.toBe('stopped');
      expect(types(h, id).filter(type => type === 'session.resumed')).toHaveLength(1);
      expect(types(h, id)).not.toContain('session.auto_resume_skipped');
      expect(types(h, id)).not.toContain('session.auto_resumed');
      expect(summaryOf(h)).toBeNull();
      await h.stop();
    });

    test('W3-2 a pass that wins the ferret leaves the Warden nothing to relaunch, and the ferret is resumed once', async () => {
      let { h, runner } = await boot([fakeRuntimes(yes).plugin]);
      const id = await start(h, 'yew');
      h = await hostRestart(h, runner);
      const launches = runner.starts;
      await h.runJob(TURN_WATCH_JOB);

      await runPass(h);
      const late = await wardenRevive(h, id);
      await advance(h, 60_000);

      expect(late).toMatchObject({ ok: true });
      expect(runner.starts).toBe(launches + 1);
      expect(types(h, id).filter(type => type === 'session.resumed')).toHaveLength(1);
      expect(types(h, id)).toContain('session.auto_resumed');
      expect(types(h, id)).not.toContain('session.auto_resume_skipped');
      await h.stop();
    });
  });
});
