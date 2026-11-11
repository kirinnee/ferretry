import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { FakeAsks } from '../../../../asks/contract/testing/index.ts';
import { Harnesses, Runners } from '../../../../ferrets/contract/index.ts';
import { FakeHarness, FakeRunner } from '../../../../ferrets/contract/testing/index.ts';
import { FakeGate, ownerStanding, StandInAdmission } from '../../../../gate/contract/testing/index.ts';
import { FakeVault } from '../../../../vault/contract/testing/index.ts';
import { QUESTION_ANSWERED_STATE, QUESTION_STATE } from '../../../../../plugins/conversation/contract/index.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { daemonImplementations } from '../../../src/generated/plugins.ts';
import { owner, type TestHost, testHost } from '../../../testing/index.ts';

/**
 * Answering a structured question through the daemon: the REAL Ferrets and the REAL Conversation halves, as the
 * generated registry builds them, over a fake runner whose pane shows a Claude form. `POST /v1/ferrets/:id/answer`
 * reaches the pane only through Ferrets' form seam (the runner's guarded `formKey`/`formPaste`), types the keys in
 * order against the frame it captured, and leaves the question answered: `question.json` gone, the stamp written, and
 * `conversation.question-answered` published.
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

const RULE = '─'.repeat(40);
const frame = (rows: readonly string[], cursor: number, asks = 'Deploy?'): string =>
  [
    RULE,
    asks,
    '',
    ...rows.map((row, index) => `${index === cursor ? '❯' : ' '} ${index + 1}. ${row}`),
    RULE,
    `  ${rows.length + 1}. Chat about this`,
  ].join('\n');

const ROWS = ['Yes', 'No', 'Other'];

/** A pane that moves its cursor on Up/Down and drops to a prompt on Enter, as the form does. */
function formPane(runner: FakeRunner, asks = 'Deploy?') {
  let cursor = 0;
  const draw = (answered: boolean) => {
    const visible = answered ? '> ' : frame(ROWS, cursor, asks);
    runner.form = { alive: true, dead: false, promptReady: answered, activeWork: false, visible, history: visible };
  };
  draw(false);
  runner.onFormWrite = ({ key }) => {
    if (key === 'Down') cursor = Math.min(cursor + 1, ROWS.length - 1);
    if (key === 'Up') cursor = Math.max(cursor - 1, 0);
    draw(key === 'Enter');
  };
}

async function boot(runner: FakeRunner): Promise<{ host: TestHost; ferret: string }> {
  const host = await testHost({
    plugins: [real('ferrets'), real('conversation'), harnessPlugin(new FakeHarness()), runnerPlugin(runner)],
    gate: new StandInAdmission(() => ownerStanding()),
    fakes: { gate: new FakeGate(), vault: new FakeVault(), asks: new FakeAsks() },
  });
  const started = await host.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': randomUUID() },
    body: { folder: '/work/a', prompt: 'Ask me.' },
  });
  expect(started.status).toBeLessThan(300);
  const ferret = started.json<{ id: string }>().id;
  await host.settle();
  host.state('conversation').plant(
    QUESTION_STATE,
    JSON.stringify({
      format: 1,
      toolUseId: 'toolu_1',
      text: 'Deploy?',
      options: ROWS.map(label => ({ label })),
      multiple: false,
      askedAt: '2026-11-07T08:59:00.000Z',
      transcript: '/transcripts/a.jsonl',
    }),
    ferret,
  );
  return { host, ferret };
}

/** POSTs an answer and moves the driven clock while the driver polls the pane for the form to move on. */
async function answer(host: TestHost, ferret: string, body: unknown, requestId = 'req-1') {
  let settled = false;
  const done = host
    .request('POST', `/v1/ferrets/${ferret}/answer`, {
      as: owner(),
      body,
      headers: { 'x-fy-request-id': requestId },
    })
    .finally(() => {
      settled = true;
    });
  for (let round = 0; round < 200 && !settled; round += 1) {
    await host.clock.advance(250);
    await Bun.sleep(0);
  }
  return await done;
}

describe('answering a structured question through the real Ferrets and Conversation halves', () => {
  test('the keys are typed in order into the captured form, then the question is answered and cleared', async () => {
    const runner = new FakeRunner();
    formPane(runner);
    const { host, ferret } = await boot(runner);

    const response = await answer(host, ferret, { toolUseId: 'toolu_1', labels: ['No'] });

    expect(response.status).toBe(200);
    expect(runner.formKeys.map(entry => entry.key)).toEqual(['Down', 'Enter']);
    expect(runner.formPastes).toEqual([]);
    expect(host.state('conversation').raw(QUESTION_STATE, ferret)).toBeUndefined();
    expect(host.state('conversation').raw(QUESTION_ANSWERED_STATE, ferret)).toContain('toolu_1');
    expect(host.published.map(event => event.event)).toContain('conversation.question-answered');
    const asked = await host.request('GET', `/v1/ferrets/${ferret}/question`, { as: owner() });
    expect(asked.json()).toEqual({ question: null });
    await host.stop();
  });

  test('a form that drifted from the stored question is refused and nothing is typed', async () => {
    const runner = new FakeRunner();
    formPane(runner, 'Something else entirely?');
    const { host, ferret } = await boot(runner);

    const response = await answer(host, ferret, { toolUseId: 'toolu_1', labels: ['No'] });

    expect(response.status).toBe(409);
    expect(runner.formKeys.map(entry => entry.key)).toEqual([]);
    expect(host.state('conversation').raw(QUESTION_STATE, ferret)).toContain('toolu_1');
    await host.stop();
  });

  test('a replay of the same request after it settled types nothing more', async () => {
    const runner = new FakeRunner();
    formPane(runner);
    const { host, ferret } = await boot(runner);
    await answer(host, ferret, { toolUseId: 'toolu_1', labels: ['No'] });

    const again = await answer(host, ferret, { toolUseId: 'toolu_1', labels: ['No'] });

    expect(again.status).toBe(200);
    expect(runner.formKeys).toHaveLength(2);
    await host.stop();
  });
});
