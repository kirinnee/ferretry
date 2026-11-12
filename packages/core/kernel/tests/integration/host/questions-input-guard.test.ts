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
 * EVERY NATIVE INPUT OF A STRUCTURED ANSWER IS BOUND TO THE FORM IT WAS MEANT FOR (rv2 findings 1 and 2).
 *
 * The REAL Ferrets and Conversation halves, as the generated registry builds them, over a fake runner whose pane the test
 * redraws at the worst moments: a permission prompt replacing the question before the first key, between two keys, and
 * after the free-form text was pasted; and a form whose cursor cannot be read. The pane is the only thing that can say
 * what a key would land on, so the proof is what the runner was asked to type. (The grant rules of this route are the
 * Gate package's own, `answer-route-grants.test.ts`, over the real admission.)
 *
 * CI only (integration tier). Fixture values only; the permission prompt is a drawing, nothing is ever run.
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

const PERMISSION =
  'Bash command\nrm -rf /work/data\nDo you want to proceed?\n❯ 1. Yes\n  2. Yes, and do not ask again\n  3. No';

/** Redraws the native pane as a permission prompt (a fixture: no command is ever run). */
function showPermission(runner: FakeRunner): void {
  runner.form = {
    alive: true,
    dead: false,
    promptReady: false,
    activeWork: false,
    visible: PERMISSION,
    history: PERMISSION,
  };
}

/** A Claude form with an inline text row: pasting replaces the row with the text, and Enter answers. */
function inlinePane(runner: FakeRunner, afterPaste?: () => void) {
  const rows = ['Yes', 'No', 'Type something.'];
  let cursor = 0;
  const draw = (answered: boolean) => {
    const visible = answered ? '> ' : frame(rows, cursor);
    runner.form = { alive: true, dead: false, promptReady: answered, activeWork: false, visible, history: visible };
  };
  draw(false);
  runner.onFormWrite = ({ key, text }) => {
    if (text !== undefined) {
      rows[2] = text;
      draw(false);
      afterPaste?.();
      return;
    }
    if (key === 'Down') cursor = Math.min(cursor + 1, rows.length - 1);
    if (key === 'Up') cursor = Math.max(cursor - 1, 0);
    draw(key === 'Enter');
  };
}

const stillPending = (host: TestHost, ferret: string): void => {
  expect(host.state('conversation').raw(QUESTION_STATE, ferret)).toContain('toolu_1');
  expect(host.state('conversation').raw(QUESTION_ANSWERED_STATE, ferret)).toBeUndefined();
};

describe('a native permission prompt never receives the keys of a question answer', () => {
  test('replacing the form before the first key: nothing is typed and the question is neither stamped nor cleared', async () => {
    const runner = new FakeRunner();
    formPane(runner);
    const { host, ferret } = await boot(runner);
    const capture = runner.formCapture.bind(runner);
    let replaced = false;
    runner.formCapture = async handle => {
      const shown = await capture(handle);
      // The driver is handed the question form it bound, and the pane becomes the prompt before its first key.
      if (!replaced) {
        replaced = true;
        showPermission(runner);
      }
      return shown;
    };
    runner.onFormWrite = () => {};

    const response = await answer(host, ferret, { toolUseId: 'toolu_1', labels: ['No'] });

    expect(response.status).toBe(409);
    expect(runner.formKeys).toEqual([]);
    expect(runner.formPastes).toEqual([]);
    stillPending(host, ferret);
    await host.stop();
  });

  test('replacing it between the arrow and Enter: the Enter is never typed into the prompt', async () => {
    const runner = new FakeRunner();
    formPane(runner);
    const { host, ferret } = await boot(runner);
    runner.onFormWrite = ({ key }) => {
      if (key === 'Down') showPermission(runner);
    };

    const response = await answer(host, ferret, { toolUseId: 'toolu_1', labels: ['No'] });

    expect(response.status).toBe(409);
    expect(runner.formKeys.map(entry => entry.key)).toEqual(['Down']);
    stillPending(host, ferret);
    await host.stop();
  });

  test('replacing it after the free-form text was pasted: the Enter is never typed into the prompt', async () => {
    const runner = new FakeRunner();
    inlinePane(runner, () => showPermission(runner));
    const { host, ferret } = await boot(runner);

    const response = await answer(host, ferret, { toolUseId: 'toolu_1', labels: [], other: 'Ask the on-call first' });

    expect(response.status).toBe(409);
    expect(runner.formKeys.map(entry => entry.key)).toEqual(['Down', 'Down']);
    stillPending(host, ferret);
    await host.stop();
  });

  test('a redraw that lags one arrow behind is waited out, and the answer still lands', async () => {
    const runner = new FakeRunner();
    formPane(runner);
    const { host, ferret } = await boot(runner);
    const capture = runner.formCapture.bind(runner);
    const before = runner.form;
    let lagged = false;
    runner.formCapture = async handle => {
      const shown = await capture(handle);
      // The first read after Down still shows the cursor on row 1.
      if (runner.formKeys.length === 1 && !lagged) {
        lagged = true;
        return before;
      }
      return shown;
    };

    const response = await answer(host, ferret, { toolUseId: 'toolu_1', labels: ['No'] });

    expect(response.status).toBe(200);
    expect(runner.formKeys.map(entry => entry.key)).toEqual(['Down', 'Enter']);
    await host.stop();
  });

  test('a free-form answer typed into the inline row still lands through the guard', async () => {
    const runner = new FakeRunner();
    inlinePane(runner);
    const { host, ferret } = await boot(runner);

    const response = await answer(host, ferret, { toolUseId: 'toolu_1', labels: [], other: 'Ask the on-call first' });

    expect(response.status).toBe(200);
    expect(runner.formPastes.map(entry => entry.text)).toEqual(['Ask the on-call first']);
    expect(runner.formKeys.map(entry => entry.key)).toEqual(['Down', 'Down', 'Enter']);
    await host.stop();
  });
});

describe('a form whose cursor cannot be read is never typed into', () => {
  test('no key, no paste and no recovery Escape; the question stays and the owner is told in words', async () => {
    const runner = new FakeRunner();
    formPane(runner);
    runner.form = {
      ...runner.form!,
      visible: runner.form!.visible.replace('❯', ' '),
      history: runner.form!.history.replace('❯', ' '),
    };
    const { host, ferret } = await boot(runner);
    // The form stays open on every key, so an Escape that was sent would show.
    runner.onFormWrite = () => {};

    const response = await answer(host, ferret, { toolUseId: 'toolu_1', labels: ['No'] });

    expect(response.status).toBe(409);
    const body = response.json<{ code: string; error: string }>();
    expect(body.code).toBe('answer_form_unreadable');
    expect(body.error).toMatch(/couldn't read this question's form safely/iu);
    expect(body.error).toMatch(/answer it at the terminal/iu);
    expect(runner.formKeys).toEqual([]);
    expect(runner.formPastes).toEqual([]);
    stillPending(host, ferret);
    await host.stop();
  });

  test('two cursors are just as unreadable as none', async () => {
    const runner = new FakeRunner();
    formPane(runner);
    const twice = runner.form!.visible.replace('  2. No', '❯ 2. No');
    runner.form = { ...runner.form!, visible: twice, history: twice };
    const { host, ferret } = await boot(runner);
    runner.onFormWrite = () => {};

    const response = await answer(host, ferret, { toolUseId: 'toolu_1', labels: ['No'] });

    expect(response.status).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('answer_form_unreadable');
    expect(runner.formKeys).toEqual([]);
    stillPending(host, ferret);
    await host.stop();
  });
});
