/**
 * `fy daemon profile` on the composed Usage daemon: the kernel's event-loop tick reaches the report, so "0 stalls" measures
 * something. The kernel's own tick is driven by hand here (a test host runs none); the real meter against real timers and a
 * really blocked loop is proved in the kernel (`loop-health.test.ts`).
 */
import { afterEach, expect, test } from 'bun:test';
import { FakeFerrets } from '@ferretry/core-ferrets/contract/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import type { LoopPort } from '@ferretry/kernel/contract';
import { testHost } from '@ferretry/kernel/testing';
import { fakeConversation } from '@ferretry/plugin-conversation/contract/testing';
import { fakeLogins, sampleLogin } from '@ferretry/plugin-logins/contract/testing';
import type { PerformanceProfileView } from '../../contract/index.ts';
import usage from '../../daemon/index.ts';

type Observer = Parameters<LoopPort['observe']>[0];
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

async function profileWith(ticks: (tick: Observer) => void) {
  let heard: Observer | undefined;
  const h = await testHost({
    plugins: [usage],
    loopObserve: observer => {
      heard = observer;
      return () => {
        heard = undefined;
      };
    },
    fakes: {
      ferrets: new FakeFerrets(),
      conversation: fakeConversation(),
      logins: fakeLogins([sampleLogin('work')]),
      vault: new FakeVault(),
    },
  });
  stops.push(() => h.stop());
  const started = (await h.request('POST', '/v1/diagnostics/profile', { body: { seconds: 5 } })).json<{ id: string }>();
  await Bun.sleep(5);
  if (heard === undefined) throw new Error('Usage never asked to hear the kernel loop tick');
  ticks(heard);
  await h.clock.advance(5_000);
  let view = (await h.request('GET', `/v1/diagnostics/profile/${started.id}`)).json<PerformanceProfileView>();
  for (let attempt = 0; attempt < 50 && view.state !== 'finished'; attempt += 1) {
    await Bun.sleep(5);
    view = (await h.request('GET', `/v1/diagnostics/profile/${started.id}`)).json<PerformanceProfileView>();
  }
  if (view.state !== 'finished') throw new Error('the profile did not finish');
  return view.report;
}

test('an idle daemon profiles ticks and no lag', async () => {
  const report = await profileWith(tick => {
    for (let at = 0; at < 20; at += 1) tick(0, 1_000 + at * 250, () => []);
  });
  expect(report.eventLoop.ticks).toBe(20);
  expect(report.eventLoop.lag.maxMs).toBe(0);
  expect(report.eventLoop.blocksOver100Ms).toBe(0);
  expect(report.eventLoop.stalls).toEqual([]);
});

test('a blocked loop is a stall in the profile, named by the work in flight', async () => {
  const report = await profileWith(tick => {
    tick(0, 1_000, () => []);
    tick(1_400, 2_650, () => ['usage/usage-budget']);
    tick(0, 2_900, () => []);
  });
  expect(report.eventLoop.ticks).toBe(3);
  expect(report.eventLoop.lag.maxMs).toBe(1_400);
  expect(report.eventLoop.blocksOver100Ms).toBe(1);
  expect(report.eventLoop.blocksOver250Ms).toBe(1);
  expect(report.eventLoop.stalls).toHaveLength(1);
  expect(report.eventLoop.stalls[0]).toMatchObject({ durationMs: 1_400, during: ['usage/usage-budget'] });
});

test('the limitation no longer claims the event loop is unmeasured', async () => {
  const report = await profileWith(() => {});
  const text = report.limitations.join('\n');
  expect(text).toContain('event-loop lag and stalls');
  expect(text).not.toContain('file operations or event-loop stalls');
});
