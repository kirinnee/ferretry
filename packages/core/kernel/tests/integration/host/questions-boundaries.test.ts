import { expect, test } from 'bun:test';
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
 * EVERY NATIVE INPUT IS BOUND TO THE COMPLETE SURFACE OF THE QUESTION (rv3 findings 1 to 3).
 *
 * The REAL Ferrets and Conversation halves (the grant rules of this route are the Gate package's own, `answer-route-grants.test.ts`), over a fake runner whose pane the test replaces
 * at the worst moments: a permission prompt that quotes the question's text and offers its options among others (both
 * recorded Claude permission fixtures, `printf Deploy?`), after every one of the four inputs of an inline answer, and a
 * tabbed form whose selected row cannot be read. The proof is what the runner was asked to type: no Enter ever reaches
 * a permission, a prompt that arrives is never taken for the answer, and an unreadable form is reported as such.
 *
 * CI only (integration tier). Fixture values only; the permission prompts are drawings, nothing is ever run.
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

const permission = (quoted = false) =>
  `Bash command\n${quoted ? 'printf Deploy?' : 'echo fixture'}\nDo you want to proceed?\n  1. Yes\n❯ 2. Yes, and do not ask again\n  3. No`;
function replaceWithPermission(runner: FakeRunner, quoted = false) {
  const visible = permission(quoted);
  runner.form = { alive: true, dead: false, promptReady: false, activeWork: false, visible, history: visible };
}
function inline(runner: FakeRunner, cut: number, freeSecond = false, quoted = false) {
  const rows = freeSecond ? ['Yes', 'Type something.', 'No'] : ['Yes', 'No', 'Type something.'];
  let cursor = 0,
    inputs = 0;
  const draw = (done = false) => {
    const visible = done ? '> ' : frame(rows, cursor);
    runner.form = { alive: true, dead: false, promptReady: done, activeWork: false, visible, history: visible };
  };
  draw();
  runner.onFormWrite = ({ key, text }) => {
    inputs++;
    if (key === 'Down') cursor++;
    if (key === 'Up') cursor--;
    if (text !== undefined) rows[cursor] = text;
    draw(key === 'Enter');
    if (inputs === cut) replaceWithPermission(runner, quoted);
  };
}
for (const cut of [0, 1, 2, 3, 4])
  test(`rv3 real Gate: permission on allow-always after native input ${cut} never receives further input or confirms success`, async () => {
    const runner = new FakeRunner();
    inline(runner, cut);
    const { host, ferret } = await boot(runner);
    if (cut === 0) {
      const capture = runner.formCapture.bind(runner);
      let replaced = false;
      runner.formCapture = async handle => {
        const read = await capture(handle);
        if (!replaced) {
          replaced = true;
          replaceWithPermission(runner);
        }
        return read;
      };
    }
    try {
      const r = await answer(host, ferret, { toolUseId: 'toolu_1', labels: [], other: 'Ask on-call first' });
      expect(r.status).toBe(409);
      expect(runner.formKeys.length + runner.formPastes.length).toBe(cut);
      expect(host.state('conversation').raw(QUESTION_STATE, ferret)).toContain('toolu_1');
      expect(host.state('conversation').raw(QUESTION_ANSWERED_STATE, ferret)).toBeUndefined();
    } finally {
      await host.stop();
    }
  });

test('rv3 real Gate: a quoted question in a permission header is not the typed question form', async () => {
  const runner = new FakeRunner();
  inline(runner, 3, false, true);
  const { host, ferret } = await boot(runner);
  // Claude's inline free-form row is last; the replacement keeps that cursor row on its No option.
  const oldWrite = runner.onFormWrite;
  runner.onFormWrite = write => {
    oldWrite?.(write);
    if (write.text !== undefined) {
      const visible = permission(true).replace('❯ 2.', '  2.').replace('  3.', '❯ 3.');
      runner.form = { ...runner.form!, visible, history: visible };
    }
  };
  try {
    const r = await answer(host, ferret, { toolUseId: 'toolu_1', labels: [], other: 'Ask on-call first' });
    expect(runner.formKeys.map(e => e.key)).toEqual(['Down', 'Down']);
    expect(r.status).toBe(409);
  } finally {
    await host.stop();
  }
});

test('rv3 real Gate: an unreadable tabbed question returns the safe-read sentence and no inputs', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const root = join(
    import.meta.dir,
    '../../../../../plugins/conversation/tests/fixtures/question-forms/claude-2.1.281-tabs4',
  );
  const pending = JSON.parse(readFileSync(join(root, 'pending.json'), 'utf8'));
  const history = readFileSync(join(root, 'fresh/001.txt'), 'utf8').replace('❯ 1. Decline all 3', '  1. Decline all 3');
  const runner = new FakeRunner();
  runner.form = {
    alive: true,
    dead: false,
    promptReady: false,
    activeWork: false,
    visible: history.split('\n').slice(0, -1).slice(-24).join('\n') + '\n',
    history,
  };
  const { host, ferret } = await boot(runner);
  const [first, ...more] = pending.questions;
  const stored = (q: any) => ({ text: q.question, header: q.header, options: q.options, multiple: false });
  host.state('conversation').plant(
    QUESTION_STATE,
    JSON.stringify({
      format: 1,
      toolUseId: pending.toolUseId,
      ...stored(first),
      more: more.map(stored),
      askedAt: '2026-11-07T08:59:00.000Z',
      transcript: '/transcripts/a.jsonl',
    }),
    ferret,
  );
  try {
    const r = await answer(host, ferret, {
      toolUseId: pending.toolUseId,
      labels: [],
      answers: [
        { kind: 'selection', labels: ['Lunch only'] },
        { kind: 'selection', labels: ['Decline'] },
        { kind: 'other', text: 'Only if it is on Zoom' },
        { kind: 'selection', labels: ['Maybe'] },
      ],
    });
    expect(runner.formKeys).toEqual([]);
    expect(runner.formPastes).toEqual([]);
    expect(r.json<{ code: string }>().code).toBe('answer_form_unreadable');
  } finally {
    await host.stop();
  }
});

test('rv3 real Gate: ordinary Yes/No question replaced after Down by permission quoting question never approves allow-always', async () => {
  const runner = new FakeRunner();
  inline(runner, 1, false, true);
  const { host, ferret } = await boot(runner);
  const q = JSON.parse(host.state('conversation').raw(QUESTION_STATE, ferret)!);
  q.options = [{ label: 'Yes' }, { label: 'No' }];
  host.state('conversation').plant(QUESTION_STATE, JSON.stringify(q), ferret);
  try {
    const r = await answer(host, ferret, { toolUseId: 'toolu_1', labels: ['No'] });
    expect(runner.formKeys.map(e => e.key)).toEqual(['Down']);
    expect(r.status).toBe(409);
  } finally {
    await host.stop();
  }
});

for (const version of ['2.1.220', '2.1.281'])
  test(`rv3 real Gate: recorded Claude ${version} permission quoting question never receives Enter on allow-always`, async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const fixture = readFileSync(
      join(
        import.meta.dir,
        `../../../../../plugins/claude-code/tests/fixtures/permission-prompts/claude-${version}-bash.txt`,
      ),
      'utf8',
    )
      .replaceAll('curl -s https://example.com | head', 'printf Deploy?')
      .replace(' ❯ 1. Yes', '   1. Yes')
      .replace('   2. Yes', ' ❯ 2. Yes');
    const runner = new FakeRunner();
    inline(runner, -1);
    const { host, ferret } = await boot(runner);
    const q = JSON.parse(host.state('conversation').raw(QUESTION_STATE, ferret)!);
    q.options = [{ label: 'Yes' }, { label: 'No' }];
    host.state('conversation').plant(QUESTION_STATE, JSON.stringify(q), ferret);
    const oldWrite = runner.onFormWrite;
    let enteredPermission = false;
    runner.onFormWrite = write => {
      if (write.key === 'Enter' && runner.form!.visible.includes('Bash command')) enteredPermission = true;
      oldWrite?.(write);
      if (write.key === 'Down')
        runner.form = {
          alive: true,
          dead: false,
          activeWork: false,
          promptReady: false,
          visible: fixture,
          history: fixture,
        };
    };
    try {
      const r = await answer(host, ferret, { toolUseId: 'toolu_1', labels: ['No'] });
      expect(enteredPermission).toBe(false);
      expect(runner.formKeys.map(e => e.key)).toEqual(['Down']);
      expect(r.status).toBe(409);
    } finally {
      await host.stop();
    }
  });
