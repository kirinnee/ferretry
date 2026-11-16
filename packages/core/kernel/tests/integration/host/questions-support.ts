import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { FakeAsks } from '../../../../asks/contract/testing/index.ts';
import { Harnesses, Runners } from '../../../../ferrets/contract/index.ts';
import { FakeHarness, FakeRunner } from '../../../../ferrets/contract/testing/index.ts';
import { FakeGate, ownerStanding, StandInAdmission } from '../../../../gate/contract/testing/index.ts';
import { FakeVault } from '../../../../vault/contract/testing/index.ts';
import { QUESTION_STATE } from '../../../../../plugins/conversation/contract/index.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { daemonImplementations } from '../../../src/generated/plugins.ts';
import { owner, type TestHost, testHost } from '../../../testing/index.ts';

/** The shared fake-runner world of the structured-question answer suites: the real Ferrets and Conversation halves over a fake pane. */
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

async function boot(
  runner: FakeRunner,
  failQuestionWrite = false,
): Promise<{ host: TestHost; ferret: string; harness: FakeHarness }> {
  const harness = new FakeHarness();
  const conversation = real('conversation');
  let failedQuestionWrite = false;
  const testedConversation = {
    ...conversation,
    build: (ctx: any) =>
      conversation.build!({
        ...ctx,
        kernel: {
          ...ctx.kernel,
          state: {
            ...ctx.kernel.state,
            write: async (def: any, value: any, id: any) => {
              if (failQuestionWrite && def === QUESTION_STATE && !failedQuestionWrite) {
                failedQuestionWrite = true;
                throw new Error('transient question write');
              }
              return await ctx.kernel.state.write(def, value, id);
            },
          },
        },
      }),
  };
  const host = await testHost({
    plugins: [real('ferrets'), testedConversation, harnessPlugin(harness), runnerPlugin(runner)],
    gate: new StandInAdmission(() => ownerStanding()),
    fakes: { gate: new FakeGate(), vault: new FakeVault(), asks: new FakeAsks() },
    everyDirectory: true,
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
  return { host, ferret, harness };
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

export { answer, boot, frame };
