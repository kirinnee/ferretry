import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { FakeAsks } from '../../../../asks/contract/testing/index.ts';
import { type FerretId, Harnesses, Runners } from '../../../../ferrets/contract/index.ts';
import { FakeHarness, FakeRunner } from '../../../../ferrets/contract/testing/index.ts';
import { FakeGate, ownerStanding, StandInAdmission } from '../../../../gate/contract/testing/index.ts';
import { FakeVault } from '../../../../vault/contract/testing/index.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { daemonImplementations } from '../../../src/generated/plugins.ts';
import { type TestHost, testHost } from '../../../testing/index.ts';

/**
 * A SEND TO A FERRET WHOSE RECORD KEPT A STALE PANE HANDLE, through the daemon: the REAL Ferrets, Mailbox and Conversation
 * halves, as the generated registry builds them, over a fake runner and harness. After a tmux-server restart (or a v4
 * conversion) the handle `fern`'s record kept names `oak`'s pane. A send to `fern` must NOT be typed into `oak`'s harness: it
 * stays queued in the mailbox, and once `fern` has its own pane again it is typed there, once each, in the order sent.
 *
 * CI only (integration tier). Fixture values only.
 */
const real = (id: string) => {
  const found = daemonImplementations.find(implementation => implementation.manifest.id === id);
  if (found === undefined) throw new Error(`the generated registry has no ${id} half`);
  return found;
};

const harnessPlugin = (harness: FakeHarness) =>
  implementDaemon(
    definePlugin({
      id: 'claude-code',
      title: 'Claude Code (fake)',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: { takes: [{ hook: Harnesses, key: 'claude-code' }] },
    }),
    { build: () => ({ hooks: { 'harnesses:claude-code': harness } }) },
  );
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

async function boot(runner: FakeRunner): Promise<TestHost> {
  return await testHost({
    plugins: [
      real('ferrets'),
      real('mailbox'),
      real('conversation'),
      harnessPlugin(new FakeHarness()),
      runnerPlugin(runner),
    ],
    gate: new StandInAdmission(() => ownerStanding()),
    fakes: { gate: new FakeGate(), vault: new FakeVault(), asks: new FakeAsks() },
    everyDirectory: true,
  });
}

const startFerret = async (h: TestHost, folder: string): Promise<FerretId> => {
  const started = await h.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': randomUUID() },
    body: { folder, prompt: 'Work.' },
  });
  expect(started.status).toBeLessThan(300);
  await h.settle();
  return started.json<{ id: string }>().id as FerretId;
};

const send = async (h: TestHost, id: string, message: string) =>
  await h.request('POST', `/v1/ferrets/${id}/send`, {
    headers: { 'x-fy-request-id': randomUUID() },
    body: { message },
  });

/** The mailbox's queue for the ferret: what is waiting to be typed, and in what state. */
const queueOf = async (h: TestHost, id: string) =>
  (await h.request('GET', `/v1/ferrets/${id}/queue`)).json<{ messages: { text: string; state: string }[] }>().messages;

/** Time the mailbox's own retries run on: the runner types on I/O turns the fake clock does not drive, so wait, bounded. */
const until = async (h: TestHost, done: () => Promise<boolean> | boolean) => {
  for (let i = 0; i < 100 && !(await done()); i += 1) {
    await h.clock.advance(1_000);
    await h.settle();
    await Bun.sleep(10);
  }
};

describe('a send to a ferret whose record kept another ferret’s pane handle', () => {
  test('is not typed into that ferret, stays queued, and is typed once, in order, when the ferret has its own pane', async () => {
    const runner = new FakeRunner();
    runner.requireFerret = true;
    const h = await boot(runner);
    const fern = await startFerret(h, '/work/fern');
    const oak = await startFerret(h, '/work/oak');
    const typedBefore = runner.deliveries.length;
    // The server restarted: fern's handle now names oak's pane.
    runner.reassign(fern, oak);

    const first = await send(h, fern, 'first for fern');
    const second = await send(h, fern, 'second for fern');
    await h.settle();
    await Bun.sleep(100);

    // Nothing reached oak's harness (or anyone's): not one delivery, queue or key.
    // Accepted and queued behind a ferret that has no pane of its own to type into (a revive's to deliver into).
    for (const answer of [first, second])
      expect(answer.json<{ disposition: string; fate: string }>()).toMatchObject({
        disposition: 'queued',
        fate: 'accepted',
      });
    expect(runner.deliveries).toHaveLength(typedBefore);
    expect(runner.queued).toEqual([]);
    expect(runner.unnamed).toEqual([]);
    // Neither message was dropped or marked delivered: both are still in the mailbox, undelivered.
    const waiting = await queueOf(h, fern);
    expect(waiting.map(entry => [entry.text, entry.state]).sort()).toEqual([
      ['first for fern', 'queued'],
      ['second for fern', 'queued'],
    ]);

    // fern has its own pane again (a relaunch / settle): the queue drains into it.
    runner.reassign(oak, fern);
    await until(h, () => runner.deliveries.length >= typedBefore + 2);

    const typed = runner.deliveries.slice(typedBefore).map(entry => entry.delivery.text);
    expect(typed.filter(text => text.includes('first for fern'))).toHaveLength(1);
    expect(typed.filter(text => text.includes('second for fern'))).toHaveLength(1);
    expect(typed.findIndex(text => text.includes('first for fern'))).toBeLessThan(
      typed.findIndex(text => text.includes('second for fern')),
    );
    await h.stop();
  });
});
