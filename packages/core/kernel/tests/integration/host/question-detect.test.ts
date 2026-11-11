import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeAsks } from '../../../../asks/contract/testing/index.ts';
import { Harnesses, Runners } from '../../../../ferrets/contract/index.ts';
import { FakeHarness, FakeRunner } from '../../../../ferrets/contract/testing/index.ts';
import { FakeGate, ownerStanding, StandInAdmission } from '../../../../gate/contract/testing/index.ts';
import { FakeVault } from '../../../../vault/contract/testing/index.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { daemonImplementations } from '../../../src/generated/plugins.ts';
import { type TestHost, testHost } from '../../../testing/index.ts';

/**
 * A QUESTION CLAUDE IS ASKING, through the daemon: the REAL Ferrets and the REAL Conversation halves, as the generated
 * registry builds them. Claude Code's `PreToolUse` hook leaves the question in the ferret's own `question-asked.json`; on
 * its 2 s watch Conversation stores it as `question.json`, so `GET /v1/ferrets/:id/question` answers it and a send to the
 * ferret is refused while the form is open. A transcript that then names the call (or holds anything newer) retires it.
 *
 * CI only (integration tier). The payload is the live bytes of Claude Code 2.1.281.
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

const PAYLOAD = readFileSync(
  join(
    import.meta.dir,
    '../../../../../plugins/conversation/tests/fixtures/question-asked/claude-2.1.281-pretooluse.json',
  ),
  'utf8',
);
const TRANSCRIPT = '/home/user/.claude/projects/-work-repro/48fa096f-185c-42e1-b456-33dd3c77c5ce.jsonl';
const TOOL_USE_ID = 'toolu_01T4KnfY1in2GTL7P9wUmRtt';

async function boot() {
  const harness = new FakeHarness();
  const runner = new FakeRunner();
  const h = await testHost({
    plugins: [real('ferrets'), real('conversation'), harnessPlugin(harness), runnerPlugin(runner)],
    gate: new StandInAdmission(() => ownerStanding()),
    fakes: { gate: new FakeGate(), vault: new FakeVault(), asks: new FakeAsks() },
  });
  const started = await h.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': randomUUID() },
    body: { folder: '/work/a', prompt: 'Ask me.' },
  });
  expect(started.status).toBeLessThan(300);
  await h.settle();
  const id = started.json<{ id: string }>().id;
  harness.transcripts.set(id as never, { stamp: { file: TRANSCRIPT, size: 1, mtimeMs: 1 }, records: [] });
  return { h, harness, runner, id };
}

/** Two seconds on the watch's cadence, then until the sweep it started has finished (it is no kernel delivery `settle` waits for). */
const watchTick = async (h: TestHost) => {
  await h.clock.advance(2_000);
  await h.settle();
  for (let turn = 0; turn < 50; turn += 1) await new Promise(resolve => setTimeout(resolve, 2));
  await h.settle();
};
const asking = async (h: TestHost, id: string) => await h.request('GET', `/v1/ferrets/${id}/question`);

describe('a question the hook recorded is shown, then retired, through the real Ferrets and Conversation', () => {
  test('no hook file: no question; the file lands: the next watch tick answers it on the question route', async () => {
    const { h, id } = await boot();
    await watchTick(h);
    expect((await asking(h, id)).json<{ question?: unknown }>().question ?? null).toBeNull();

    h.putRoot('sessions', `${id}/question-asked.json`, PAYLOAD);
    await watchTick(h);

    const shown = await asking(h, id);
    expect(shown.status).toBe(200);
    expect(JSON.stringify(shown.json())).toContain(TOOL_USE_ID);
    expect(JSON.stringify(shown.json())).not.toContain(TRANSCRIPT);
    await h.stop();
  });

  test('a transcript that names the call retires it', async () => {
    const { h, harness, id } = await boot();
    h.putRoot('sessions', `${id}/question-asked.json`, PAYLOAD);
    await watchTick(h);
    expect(JSON.stringify((await asking(h, id)).json())).toContain(TOOL_USE_ID);

    harness.entries = [
      { id: 'e1', at: '2026-10-30T04:36:02.000Z' as never, role: 'tool', text: `tool_result ${TOOL_USE_ID}: answered` },
    ];
    await watchTick(h);

    expect(JSON.stringify((await asking(h, id)).json())).not.toContain(TOOL_USE_ID);
    // The stale file is never shown again.
    await watchTick(h);
    expect(JSON.stringify((await asking(h, id)).json())).not.toContain(TOOL_USE_ID);
    await h.stop();
  });

  test('an event newer than the question retires it too', async () => {
    const { h, harness, id } = await boot();
    h.putRoot('sessions', `${id}/question-asked.json`, PAYLOAD);
    await watchTick(h);
    harness.entries = [{ id: 'e2', at: '2099-01-01T00:00:00.000Z' as never, role: 'assistant', text: 'moved on' }];
    await watchTick(h);
    expect(JSON.stringify((await asking(h, id)).json())).not.toContain(TOOL_USE_ID);
    await h.stop();
  });

  test('while the form is open a send to the ferret is refused 409 and nothing is typed', async () => {
    const { h, runner, id } = await boot();
    h.putRoot('sessions', `${id}/question-asked.json`, PAYLOAD);
    await watchTick(h);
    const typed = runner.deliveries.length;

    const sent = await h.request('POST', `/v1/ferrets/${id}/send`, {
      headers: { 'x-fy-request-id': randomUUID() },
      body: { message: 'hello' },
    });

    expect(sent.status).toBe(409);
    expect(runner.deliveries).toHaveLength(typed);
    await h.stop();
  });
});
