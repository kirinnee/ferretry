/**
 * W2-a: auto-resume after a host restart, MOUNTED (today's `createAutoResume` + `BootExitRecorder`, `fyd.ts:8180`,
 * `:8388–8413`, `:13514–13522`, `:13727`). RULING #27 Q5: it fails closed — no answer of Runtimes' own is no resume
 * and nothing spent. "Spent" is a launch: `FakeRunner.starts`.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import type { TestHost } from '@ferretry/kernel/testing';
import {
  AutoResumeDecide,
  type AutoResumeDecideInput,
  AutoResumeFile,
  AutoResumeSummaryFile,
  FerretHistoryFiles,
  type FerretId,
  type FerretSummary,
} from '../../../../../contract/index.ts';
import { FakeHarness, FakeRunner } from '../../../../../contract/testing/index.ts';
import { AUTO_RESUME_JOB } from '../../../../../daemon/modules/auto-resume.ts';
import { NO_AUTO_RESUME_ANSWER } from '../../../../../daemon/lib/ferrets/auto-resume.ts';
import { host } from '../../ferrets/route-fixture.ts';

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
      hooks: { takes: [{ hook: AutoResumeDecide }] },
    }),
    {
      build: () => ({
        hooks: {
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

async function boot(plugins: ReturnType<typeof fakeRuntimes>['plugin'][]) {
  const runner = new FakeRunner();
  const h = await host([], { harness: new FakeHarness(), runner, plugins });
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
    const cases: readonly [string, ReturnType<typeof fakeRuntimes>['plugin'][]][] = [
      ['no Runtimes half', []],
      ['Runtimes throws', [fakeRuntimes(() => Promise.reject(new Error('sk-live-nope'))).plugin]],
      ['Runtimes hangs past the kernel bound', [fakeRuntimes(() => new Promise(() => undefined)).plugin]],
      ['Runtimes answers garbage (a string)', [fakeRuntimes(() => 'yes').plugin]],
      ['Runtimes answers garbage (allow: "true")', [fakeRuntimes(() => ({ allow: 'true' })).plugin]],
      ['Runtimes answers garbage (null)', [fakeRuntimes(() => null).plugin]],
      ['Runtimes answers allow: false', [fakeRuntimes(() => ({ allow: false, reason: 'off' })).plugin]],
      ['only another plugin says yes', [fakeRuntimes(yes, 'usage').plugin]],
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
    let h = await host([], { harness: new FakeHarness(), runner, plugins: [fakeRuntimes(yes).plugin] });
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
});
