import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeRunner } from '../../../../ferrets/contract/testing/index.ts';
import { QUESTION_ANSWERED_STATE, QUESTION_STATE } from '../../../../../plugins/conversation/contract/index.ts';
import { answer, boot, frame } from './questions-support.ts';

/**
 * IDENTITY IS POSITIVE AND POSITIONAL, AND NO NUMBERED SURFACE IS SUCCESS (rv5 findings 1 to 4).
 *
 * The REAL Ferrets and Conversation halves over a fake runner whose pane the test draws. No `blocking` flag is ever set
 * here, so the answer driver must refuse on its own: a row the stored question never listed that merely ends in `✔`, a
 * checkbox heading the stored payload never named, and a numbered form left behind with its cursor gone or its top
 * cropped away. And the ordinary texts that merely LOOK like decoration — a question that starts `☐`, `Question 1/2:` or
 * sits between arrows — must still be answered, as they were before the header was read by shape.
 *
 * CI only (integration tier). Fixture values only; the prompts are drawings, nothing is ever run.
 */

const fixtures = join(import.meta.dir, '../../../../../plugins/conversation/tests/fixtures/question-forms');
/** What the runner's own reader says of a frame whose footer reads `esc to interrupt` (the reader itself belongs to the terminals runner). */
const drawsActiveWork = (visible: string): boolean => /esc to interrupt/iu.test(visible);
const capture = (visible: string, promptReady = false, activeWork = false) => ({
  alive: true,
  dead: false,
  promptReady,
  activeWork,
  visible,
  history: visible,
});

for (const scenario of [
  {
    name: 'a chosen foreign row',
    header: 'Deploy?',
    rows: ['Yes', 'No', 'Allow all future operations ✔'],
    cursor: 2,
  },
  {
    name: 'an arbitrary checkbox heading above an unnamed stored header',
    header: '☐ Approval required for a different operation\nDeploy?',
    rows: ['Yes', 'No'],
    cursor: 0,
  },
])
  test(`rv5: a first capture with ${scenario.name} receives no keys`, async () => {
    const runner = new FakeRunner();
    let cursor = scenario.cursor;
    let entered = false;
    const draw = () => {
      runner.form = capture(entered ? '> ' : frame(scenario.rows, cursor, scenario.header), entered);
    };
    draw();
    runner.onFormWrite = ({ key }) => {
      if (key === 'Up') cursor--;
      if (key === 'Down') cursor++;
      if (key === 'Enter') entered = true;
      draw();
    };
    const { host, ferret } = await boot(runner);
    const pending = JSON.parse(host.state('conversation').raw(QUESTION_STATE, ferret)!);
    pending.options = [{ label: 'Yes' }, { label: 'No' }];
    host.state('conversation').plant(QUESTION_STATE, JSON.stringify(pending), ferret);
    try {
      const response = await answer(host, ferret, { toolUseId: 'toolu_1', labels: ['Yes'] });
      expect(runner.formKeys).toEqual([]);
      expect(response.status).toBe(409);
      expect(entered).toBe(false);
      expect(host.state('conversation').raw(QUESTION_ANSWERED_STATE, ferret)).toBeUndefined();
    } finally {
      await host.stop();
    }
  });

for (const ready of [false, true])
  test(`rv5: a cursorless unrelated recorded numbered form is never success (${ready ? 'prompt-ready' : 'active-work'})`, async () => {
    const runner = new FakeRunner();
    let cursor = 0;
    let replaced = false;
    const unrelated = readFileSync(join(fixtures, 'codex-0.164.0-single.txt'), 'utf8')
      .replace('Test 4c collapsed. How should we find out?', 'An unrelated question still needs an answer?')
      .replace(/›(?=\s*\d+\.)/gu, ' ');
    const draw = () => {
      runner.form = replaced
        ? capture(unrelated, ready, ready ? false : drawsActiveWork(unrelated))
        : capture(frame(['Yes', 'No', 'Other'], cursor));
    };
    draw();
    runner.onFormWrite = ({ key }) => {
      if (key === 'Down') cursor++;
      if (key === 'Enter') replaced = true;
      draw();
    };
    const { host, ferret } = await boot(runner);
    try {
      const response = await answer(host, ferret, { toolUseId: 'toolu_1', labels: ['Yes'] });
      expect(response.status).toBe(409);
      expect(host.state('conversation').raw(QUESTION_STATE, ferret)).toContain('toolu_1');
      expect(host.state('conversation').raw(QUESTION_ANSWERED_STATE, ferret)).toBeUndefined();
    } finally {
      await host.stop();
    }
  });

for (const question of ['☐ Include optional tests?', 'Question 1/2: should we deploy?', '← Which direction? →'])
  test(`rv5: a question whose own text looks like decoration is still answered: ${question}`, async () => {
    const runner = new FakeRunner();
    let done = false;
    const draw = () => {
      runner.form = capture(done ? '> ' : frame(['Yes', 'No', 'Type something.'], 0, question), done);
    };
    draw();
    runner.onFormWrite = ({ key }) => {
      if (key === 'Enter') done = true;
      draw();
    };
    const { host, ferret } = await boot(runner);
    const pending = JSON.parse(host.state('conversation').raw(QUESTION_STATE, ferret)!);
    pending.text = question;
    pending.options = [{ label: 'Yes' }, { label: 'No' }];
    host.state('conversation').plant(QUESTION_STATE, JSON.stringify(pending), ferret);
    try {
      const response = await answer(host, ferret, { toolUseId: 'toolu_1', labels: ['Yes'] });
      expect(response.status).toBe(200);
      expect(done).toBe(true);
    } finally {
      await host.stop();
    }
  });

test('rv5: a partially visible unrelated numbered form cannot become active-work confirmation', async () => {
  const runner = new FakeRunner();
  let replaced = false;
  const native = readFileSync(join(fixtures, 'codex-0.164.0-single.txt'), 'utf8');
  const partial = native.slice(native.indexOf('    2. I will check Vault')).replace('    2.', '  › 2.');
  expect(partial).toContain('3. Skip; test with jitter');
  expect(drawsActiveWork(partial)).toBe(true);
  const draw = () => {
    runner.form = replaced
      ? capture(partial, false, drawsActiveWork(partial))
      : capture(frame(['Yes', 'No', 'Other'], 0));
  };
  draw();
  runner.onFormWrite = ({ key }) => {
    if (key === 'Enter') replaced = true;
    draw();
  };
  const { host, ferret } = await boot(runner);
  try {
    const response = await answer(host, ferret, { toolUseId: 'toolu_1', labels: ['Yes'] });
    expect(response.status).toBe(409);
    expect(host.state('conversation').raw(QUESTION_ANSWERED_STATE, ferret)).toBeUndefined();
  } finally {
    await host.stop();
  }
});

test('rv5: a partially visible numbered form with its cursor gone is still not success', async () => {
  const runner = new FakeRunner();
  let replaced = false;
  const native = readFileSync(join(fixtures, 'codex-0.164.0-single.txt'), 'utf8');
  const partial = native.slice(native.indexOf('    2. I will check Vault'));
  const draw = () => {
    runner.form = replaced ? capture(partial, true, false) : capture(frame(['Yes', 'No', 'Other'], 0));
  };
  draw();
  runner.onFormWrite = ({ key }) => {
    if (key === 'Enter') replaced = true;
    draw();
  };
  const { host, ferret } = await boot(runner);
  try {
    const response = await answer(host, ferret, { toolUseId: 'toolu_1', labels: ['Yes'] });
    expect(response.status).toBe(409);
    expect(host.state('conversation').raw(QUESTION_ANSWERED_STATE, ferret)).toBeUndefined();
  } finally {
    await host.stop();
  }
});
