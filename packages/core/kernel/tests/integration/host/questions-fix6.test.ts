import { expect, test } from 'bun:test';
import { FakeRunner } from '../../../../ferrets/contract/testing/index.ts';
import { QUESTION_ANSWERED_STATE, QUESTION_STATE } from '../../../../../plugins/conversation/contract/index.ts';
import { answer, boot, frame } from './questions-support.ts';

/**
 * THE FORM'S TOP IS STRUCTURAL, EVERY LINE BELOW IT IS CONSUMED, AND NO CHIP IS GUESSED (rv6 findings 1 and 2).
 *
 * The REAL Ferrets and Conversation halves over a fake runner whose pane the test draws; no `blocking` flag is set, so the
 * answer driver must refuse on its own. Each drawing puts one unexplained line between the form's top (the harness's
 * rule) and the question's text, or a decoration in a place the harness never draws it: the answer must send NO input,
 * answer 409 and leave the question pending and unstamped. The last block holds the controls that must keep working.
 *
 * CI only (integration tier). Fixture values only; the prompts are drawings, nothing is ever run.
 */

const capture = (visible: string, promptReady = false) => ({
  alive: true,
  dead: false,
  promptReady,
  activeWork: false,
  visible,
  history: visible,
});

interface Scenario {
  readonly name: string;
  readonly head: string;
  readonly stored?: string;
  readonly question?: string;
}

const refused: readonly Scenario[] = [
  { name: 'a headerless question under a short foreign heading and a blank', head: '☐ Approve all\n\nDeploy?' },
  { name: 'a foreign heading above a Codex header', head: 'Approval for a different operation\nQuestion 1/1\nDeploy?' },
  { name: 'the own chip above the Codex header', head: '☐ Deploy\nQuestion 1/1\nDeploy?', stored: 'Deploy' },
  { name: 'two own chips around a Codex header', head: '☐ Deploy\nQuestion 1/1\n☐ Deploy\nDeploy?', stored: 'Deploy' },
  {
    name: 'a foreign heading above a tab strip',
    head: 'Approval for a different operation\n←  ☐ Deploy  ✔ Submit  →\nDeploy?',
    stored: 'Deploy',
  },
  {
    name: 'a longer body ending in the stored Codex-shaped literal',
    head: 'Approval for an unrelated operation\nQuestion 1/1',
    question: 'Question 1/1',
  },
  {
    name: 'a longer body ending in the stored strip-shaped literal',
    head: 'Approval for an unrelated operation\n←  ☐ Deploy  ✔ Submit  →',
    question: '←  ☐ Deploy  ✔ Submit  →',
    stored: 'Deploy',
  },
];

async function drive(scenario: Scenario) {
  const runner = new FakeRunner();
  let entered = false;
  const draw = () => {
    runner.form = capture(entered ? '> ' : frame(['Yes', 'No'], 0, scenario.head), entered);
  };
  draw();
  runner.onFormWrite = ({ key }) => {
    if (key === 'Enter') entered = true;
    draw();
  };
  const { host, ferret } = await boot(runner);
  const stored = JSON.parse(host.state('conversation').raw(QUESTION_STATE, ferret)!);
  stored.options = [{ label: 'Yes' }, { label: 'No' }];
  if (scenario.stored !== undefined) stored.header = scenario.stored;
  if (scenario.question !== undefined) stored.text = scenario.question;
  host.state('conversation').plant(QUESTION_STATE, JSON.stringify(stored), ferret);
  try {
    const response = await answer(host, ferret, { toolUseId: 'toolu_1', labels: ['Yes'] });
    return {
      status: response.status,
      keys: runner.formKeys.map(entry => entry.key),
      stamp: host.state('conversation').raw(QUESTION_ANSWERED_STATE, ferret),
      pending: host.state('conversation').raw(QUESTION_STATE, ferret) !== undefined,
    };
  } finally {
    await host.stop();
  }
}

for (const scenario of refused)
  test(`rv6: ${scenario.name} receives no keys and stays pending`, async () => {
    const result = await drive(scenario);
    expect(result.keys).toEqual([]);
    expect(result.status).toBe(409);
    expect(result.stamp).toBeUndefined();
    expect(result.pending).toBe(true);
  });

for (const head of [
  '☐ Deploy\n☐ Deploy\nDeploy?',
  'Deploy?\n☐ Deploy',
  'Deploy? and another operation',
  '☐ Other\nDeploy?',
])
  test(`rv6: a visibly bad header stays refused: ${JSON.stringify(head)}`, async () => {
    const result = await drive({ name: head, head, stored: 'Deploy' });
    expect(result.keys).toEqual([]);
    expect(result.status).toBe(409);
  });

for (const scenario of [
  { name: 'the own chip above the question', head: '☐ Deploy\n\nDeploy?', stored: 'Deploy' },
  { name: 'a headerless question with nothing above it', head: 'Deploy?' },
  {
    name: 'a question literally starting like a Codex header',
    head: 'Question 1/2: Deploy?',
    question: 'Question 1/2: Deploy?',
  },
  { name: 'a question starting with a checkbox', head: '☐ Deploy?', question: '☐ Deploy?' },
] satisfies Scenario[])
  test(`rv6: an ordinary form still answers: ${scenario.name}`, async () => {
    const result = await drive(scenario);
    expect(result.status).toBe(200);
    expect(result.keys).toContain('Enter');
  });
