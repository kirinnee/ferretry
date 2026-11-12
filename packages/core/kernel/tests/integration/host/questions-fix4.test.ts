import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeRunner } from '../../../../ferrets/contract/testing/index.ts';
import { QUESTION_ANSWERED_STATE, QUESTION_STATE } from '../../../../../plugins/conversation/contract/index.ts';
import { answer, boot, frame } from './questions-support.ts';

/**
 * ANSWERING BINDS TO THE STORED QUESTION AND ONLY REAL SUCCESS IS SUCCESS (rv4 findings 1 to 5).
 *
 * The REAL Ferrets and Conversation halves over a fake runner whose pane the test replaces with surfaces the runner's own
 * readers do not recognise (no `blocking` flag is ever set here, so the answer driver must refuse on its own): an unknown
 * permission present on the FIRST capture, an unnumbered dialog standing where a free-form page should be, and another
 * blocking numbered form whose footer says `esc to interrupt`. The proof is what the runner was asked to type and what the
 * route answered. The two ordinary flows that were refused wrongly — an inline answer with two spaces, and a typed tab met
 * on the way back to an earlier mismatch — must reach 200.
 *
 * CI only (integration tier). Fixture values only; the prompts are drawings, nothing is ever run.
 */

const conversationFixtures = join(import.meta.dir, '../../../../../plugins/conversation/tests/fixtures/question-forms');
const terminalFixtures = join(import.meta.dir, '../../../../../plugins/terminals/tests/fixtures');
const capture = (visible: string, promptReady = false) => ({
  alive: true,
  dead: false,
  activeWork: false,
  promptReady,
  visible,
  history: visible,
});

const unknownPermission = readFileSync(join(terminalFixtures, 'permission-prompts/claude-2.1.220-bash.txt'), 'utf8')
  .replaceAll('curl -s https://example.com | head', 'printf Deploy?')
  .replace('Do you want to proceed?', 'Approval required')
  .replace(/.*Esc to cancel.*\n?/gu, '')
  .replace(' ❯ 1. Yes', '   1. Yes')
  .replace('   2. Yes', ' ❯ 2. Yes');

test('rv4: a mid-redraw permission already present on the first capture receives no question keys', async () => {
  const runner = new FakeRunner();
  runner.form = capture(unknownPermission);
  const { host, ferret } = await boot(runner);
  const pending = JSON.parse(host.state('conversation').raw(QUESTION_STATE, ferret)!);
  pending.options = [{ label: 'Yes' }, { label: 'No' }];
  host.state('conversation').plant(QUESTION_STATE, JSON.stringify(pending), ferret);
  let visible = unknownPermission;
  let enteredPermission = false;
  runner.onFormWrite = ({ key }) => {
    if (key === 'Up') visible = visible.replace(' ❯ 2.', '   2.').replace('   1.', ' ❯ 1.');
    if (key === 'Enter') {
      enteredPermission = true;
      runner.form = capture('> ', true);
    } else runner.form = capture(visible);
  };
  try {
    const response = await answer(host, ferret, { toolUseId: 'toolu_1', labels: ['Yes'] });
    expect(runner.formKeys).toEqual([]);
    expect(runner.formPastes).toEqual([]);
    expect(response.status).toBe(409);
    expect(enteredPermission).toBe(false);
    expect(host.state('conversation').raw(QUESTION_STATE, ferret)).toContain('toolu_1');
    expect(host.state('conversation').raw(QUESTION_ANSWERED_STATE, ferret)).toBeUndefined();
  } finally {
    await host.stop();
  }
});

test('rv4: a menu holding the stored options among other rows is not the question on the first capture', async () => {
  const runner = new FakeRunner();
  runner.form = capture(frame(['Yes', 'No', 'Other', 'Deny and delete everything'], 0));
  const { host, ferret } = await boot(runner);
  try {
    const response = await answer(host, ferret, { toolUseId: 'toolu_1', labels: ['Yes'] });
    expect(runner.formKeys).toEqual([]);
    expect(response.status).toBe(409);
  } finally {
    await host.stop();
  }
});

test('rv4: an unrelated blocking numbered form is not success just because its footer says esc to interrupt', async () => {
  const runner = new FakeRunner();
  const original = readFileSync(join(conversationFixtures, 'codex-0.164.0-single.txt'), 'utf8');
  let cursor = 0;
  let replaced = false;
  const draw = () => {
    let visible = replaced
      ? original.replace('Test 4c collapsed. How should we find out?', 'Which unrelated deployment should run next?')
      : original;
    let row = 0;
    visible = visible.replace(
      /^( {2}[› ] )(\d+\. .*)$/gmu,
      (_all, _lead, rest) => `  ${row++ === cursor ? '›' : ' '} ${rest}`,
    );
    runner.form = { ...capture(visible), activeWork: /esc to interrupt/iu.test(visible) };
  };
  draw();
  runner.onFormWrite = ({ key }) => {
    if (key === 'Down') cursor++;
    if (key === 'Enter') replaced = true;
    draw();
  };
  const { host, ferret } = await boot(runner);
  const stored = JSON.parse(host.state('conversation').raw(QUESTION_STATE, ferret)!);
  stored.text = 'Test 4c collapsed. How should we find out?';
  stored.options = ['Read one prod pod (Recommended)', 'I will check Vault', 'Skip; test with jitter'].map(label => ({
    label,
  }));
  host.state('conversation').plant(QUESTION_STATE, JSON.stringify(stored), ferret);
  try {
    const response = await answer(host, ferret, { toolUseId: 'toolu_1', labels: ['I will check Vault'] });
    expect(replaced).toBe(true);
    expect(runner.form?.activeWork).toBe(true);
    expect(response.status).toBe(409);
    expect(host.state('conversation').raw(QUESTION_STATE, ferret)).toContain('toolu_1');
    expect(host.state('conversation').raw(QUESTION_ANSWERED_STATE, ferret)).toBeUndefined();
  } finally {
    await host.stop();
  }
});

test('rv4: an unknown non-numbered dialog replacing a free-form page receives no paste or Enter', async () => {
  const runner = new FakeRunner();
  const rows = ['Yes', 'No', 'Other…'];
  let cursor = 0;
  let inDialog = false;
  let enteredDialog = false;
  const dialog = readFileSync(join(terminalFixtures, 'harness-dialogs/claude-2.1.281-mcp-servers.txt'), 'utf8')
    .replace('New MCP server found in this project', 'New MCP server found in this project: Deploy?')
    .replace(/.*(?:Enter|Esc).*\n?/gu, '');
  runner.form = capture(frame(rows, cursor));
  runner.onFormWrite = ({ key }) => {
    if (inDialog) {
      if (key === 'Enter') {
        enteredDialog = true;
        runner.form = capture('> ', true);
      }
      return;
    }
    if (key === 'Down') cursor++;
    if (key === 'Enter') {
      inDialog = true;
      runner.form = capture(dialog);
    } else runner.form = capture(frame(rows, cursor));
  };
  const { host, ferret } = await boot(runner);
  try {
    const response = await answer(host, ferret, { toolUseId: 'toolu_1', labels: [], other: 'Ask on-call first' });
    expect(runner.formPastes).toEqual([]);
    expect(enteredDialog).toBe(false);
    expect(response.status).toBe(409);
    expect(host.state('conversation').raw(QUESTION_ANSWERED_STATE, ferret)).toBeUndefined();
  } finally {
    await host.stop();
  }
});

const single = readFileSync(join(conversationFixtures, 'claude-2.1.281-single-80x24.txt'), 'utf8');
const singleQuestion =
  "Test 4c collapsed, and the next test depends on which pool settings prod's Valkey client really uses. How should we find out?";
const singleOptions = ['Read one prod pod (Recommended)', "I'll check Vault", 'Skip; test with jitter'];
for (const text of ['Ask the on-call first', 'Ask  the on-call first', 'Ask\tthe on-call first'])
  test(`rv4: an ordinary inline answer is verified by its whole drawn row: ${JSON.stringify(text)}`, async () => {
    const runner = new FakeRunner();
    let cursor = 0;
    let pasted: string | undefined;
    let done = false;
    const draw = () => {
      let row = 0;
      let visible = single.replace(
        /^([❯ ]) (\d+\. .*)$/gmu,
        (_all, _mark, rest) => `${row++ === cursor ? '❯' : ' '} ${rest}`,
      );
      if (pasted !== undefined) visible = visible.replace('Type something.', pasted);
      if (done) visible = '> ';
      runner.form = capture(visible, done);
    };
    draw();
    runner.onFormWrite = ({ key, text }) => {
      if (key === 'Down') cursor++;
      if (key === 'Up') cursor--;
      if (text !== undefined) pasted = text;
      if (key === 'Enter') done = true;
      draw();
    };
    const { host, ferret } = await boot(runner);
    const stored = JSON.parse(host.state('conversation').raw(QUESTION_STATE, ferret)!);
    stored.text = singleQuestion;
    stored.options = singleOptions.map(label => ({ label }));
    host.state('conversation').plant(QUESTION_STATE, JSON.stringify(stored), ferret);
    try {
      const response = await answer(host, ferret, { toolUseId: 'toolu_1', labels: [], other: text });
      expect(response.status).toBe(200);
      expect(done).toBe(true);
      expect(runner.formPastes.map(entry => entry.text)).toEqual([text]);
    } finally {
      await host.stop();
    }
  });

const tabs = join(conversationFixtures, 'claude-2.1.281-tabs4');
const tabsPending = JSON.parse(readFileSync(join(tabs, 'pending.json'), 'utf8'));
const tabScreen = (name: string) => readFileSync(join(tabs, `${name}.txt`), 'utf8');
function cursorAt(text: string, cursor: number): string {
  const lines = text.split('\n');
  const start = lines.findLastIndex(line => /^[❯ ] 1\. /u.test(line));
  let row = 0;
  for (let index = start; index >= 0 && index < lines.length; index++) {
    if (/^─{8}/u.test(lines[index]!)) break;
    if (/^[❯ ] \d+\. /u.test(lines[index]!))
      lines[index] = lines[index]!.replace(/^[❯ ]/u, row++ === cursor ? '❯' : ' ');
  }
  return lines.join('\n');
}
for (const typed of [false, true])
  test(`rv4: a recorded mismatch is corrected by going back across ${typed ? 'a typed' : 'a selected'} tab`, async () => {
    const runner = new FakeRunner();
    const nodes = [1, 2, 4, 10, 8, 6, 8, 10, 12, 14].map(n => `mismatch/${String(n).padStart(3, '0')}`);
    let node = 0;
    let cursor = 0;
    let pasted: string | undefined;
    const drawn = () => {
      let history = tabScreen(nodes[node]!);
      if (typed) {
        if ([4, 6].includes(node))
          history = history
            .replace('2. Decline ✔', '2. Decline')
            .replace('3. Type something.', '3. Only if it is on Zoom ✔');
        if ([2, 8].includes(node)) {
          const at = history.lastIndexOf('→ Decline');
          history = history.slice(0, at) + history.slice(at).replace('→ Decline', '→ Only if it is on Zoom');
        }
      }
      history = cursorAt(history, cursor);
      if (pasted !== undefined) history = history.replace('Type something.', pasted);
      const visible = `${history.split('\n').slice(0, -1).slice(-24).join('\n')}\n`;
      runner.form = { alive: true, dead: false, promptReady: false, activeWork: node === 9, visible, history };
    };
    drawn();
    runner.onFormWrite = ({ key, text }) => {
      if (key === 'Down') cursor++;
      if (key === 'Up') cursor--;
      if (text !== undefined) pasted = text;
      if (key === 'Enter' || key === 'Left' || key === 'Right') {
        const expected = node < 2 || node === 5 || node === 8 ? 'Enter' : node < 5 ? 'Left' : 'Right';
        if (key !== expected) throw new Error(`node ${node} expected ${expected}, got ${key}`);
        node++;
        cursor = 0;
        pasted = undefined;
      }
      drawn();
    };
    const { host, ferret } = await boot(runner);
    const item = (q: any) => ({ text: q.question, header: q.header, options: q.options, multiple: false });
    const [first, ...rest] = tabsPending.questions;
    host.state('conversation').plant(
      QUESTION_STATE,
      JSON.stringify({
        format: 1,
        toolUseId: tabsPending.toolUseId,
        ...item(first),
        more: rest.map(item),
        askedAt: '2026-11-07T08:59:00.000Z',
        transcript: '/transcripts/a.jsonl',
      }),
      ferret,
    );
    try {
      const response = await answer(host, ferret, {
        toolUseId: tabsPending.toolUseId,
        labels: [],
        answers: [
          { kind: 'selection', labels: ['Decline all 3'] },
          { kind: 'selection', labels: ['Maybe'] },
          typed ? { kind: 'other', text: 'Only if it is on Zoom' } : { kind: 'selection', labels: ['Decline'] },
          { kind: 'selection', labels: ['Accept'] },
        ],
      });
      expect(response.status).toBe(200);
      expect(node).toBe(9);
    } finally {
      await host.stop();
    }
  });
