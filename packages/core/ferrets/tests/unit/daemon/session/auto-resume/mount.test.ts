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
  FerretHistoryFiles,
  type FerretId,
  FerretsPort,
  type FerretSummary,
  RUNTIME_START_KEY,
  RuntimeStart,
  StartDecide,
  type StartDecideInput,
} from '../../../../../contract/index.ts';
import { FakeHarness, FakeRunner } from '../../../../../contract/testing/index.ts';
import { AUTO_RESUME_JOB } from '../../../../../daemon/modules/auto-resume.ts';
import { NO_AUTO_RESUME_ANSWER } from '../../../../../daemon/lib/ferrets/auto-resume.ts';
import { fakeLogins, fakeRuntimeStartAnswer, host } from '../../ferrets/route-fixture.ts';

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
  const h = await host([], { harness: new FakeHarness(), runner, plugins: [...plugins, fakeLogins()] });
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

/** Moves the driven clock and lets what it woke run to its end. */
async function advance(h: TestHost, by: number): Promise<void> {
  await h.clock.advance(by);
  for (let turn = 0; turn < 40; turn += 1) {
    await h.clock.advance(0);
    await Bun.sleep(0);
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
    expect(types(h, id)).toContain('session.auto_resume_skipped');
    expect(types(h, id)).not.toContain('session.auto_resumed');
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
    // Late on BOTH clocks: the daemon bounds a decide on the kernel clock, this test host on a real-time timer, so an
    // answer late on only one of them would prove nothing about the other.
    test('W2-a a LATE yes (300 ms, past the 200 ms decide bound on the kernel clock and in real time) resumes nothing', async () => {
      const plugin = implementDaemon(
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
                if (input.ask === 'runtime') {
                  await ctx.kernel.clock.sleep(milliseconds(300));
                  await Bun.sleep(300);
                }
                return { allow: true } as never;
              },
            },
          }),
        },
      );
      let { h, runner } = await boot([plugin as never]);
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
});
