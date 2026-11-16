/**
 * ORDINARY ANSWERS KEEP WORKING (rv5): every recorded native layout, all three choices, inline text with double spaces, a tab, a
 * newline and Unicode, Codex's recorded notes suffix, and the supported synthetic plain-Other page — through the real guard.
 * A false refusal of any of them is as much a finding as a wrong key. CI only (integration tier); fixture values only.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeRunner } from '../../../../ferrets/contract/testing/index.ts';
import { QUESTION_STATE, QUESTION_ANSWERED_STATE } from '../../../../../plugins/conversation/contract/index.ts';
import { answer, boot, frame } from './questions-support.ts';
const fixtures = join(import.meta.dir, '../../../../../plugins/conversation/tests/fixtures/question-forms');
const read = (name: string) => readFileSync(join(fixtures, name + '.txt'), 'utf8');
const claudeQ =
  'Test 4c collapsed, and the next test depends on which pool settings prod\u0027s Valkey client really uses. How should we find out?';
const codexQ =
  'Test 4c collapsed, and the next test depends on which pool settings prod Valkey client really uses. How should we find out?';
const claudeOptions = ['Read one prod pod (Recommended)', 'I\u0027ll check Vault', 'Skip; test with jitter'];
const codexOptions = ['Read one prod pod (Recommended)', 'I will check Vault', 'Skip; test with jitter'];
const cap = (visible: string, done = false, history = visible) => ({
  alive: true,
  dead: false,
  promptReady: done,
  activeWork: false,
  visible,
  history,
});
const cases = [
  { name: 'claude-2.1.281-single-80x24', q: claudeQ, opts: claudeOptions, header: 'Pool check' },
  {
    name: 'claude-2.1.281-tall-80x16.visible',
    q: claudeQ,
    opts: claudeOptions,
    header: 'Pool check',
    history: 'claude-2.1.281-tall-80x16.history',
  },
  { name: 'codex-0.156.1-single-80x24', q: codexQ, opts: codexOptions },
  { name: 'codex-0.164.0-single', q: 'Test 4c collapsed. How should we find out?', opts: codexOptions },
];
function cursorAt(text: string, cursor: number) {
  const lines = text.split('\n');
  const start = lines.findLastIndex(line => /^\s{0,2}[❯› ] 1\. /u.test(line));
  let row = 0;
  for (let i = start; i >= 0 && i < lines.length; i++) {
    if (/^─{8}/u.test(lines[i]!)) break;
    lines[i] = lines[i]!.replace(
      /^( {0,2})[❯› ] (\d+\. .*)$/u,
      (_all, lead, rest) => `${lead}${row++ === cursor ? (lead ? '›' : '❯') : ' '} ${rest}`,
    );
  }
  return lines.join('\n');
}
for (const fixture of cases)
  for (const selection of [0, 1, 2])
    test(`rv5 native ordinary ${fixture.name} selects option ${selection + 1}`, async () => {
      const runner = new FakeRunner();
      let cursor = 0;
      let done = false;
      const draw = () => {
        const visible = done ? '> ' : cursorAt(read(fixture.name), cursor);
        const history = fixture.history && !done ? cursorAt(read(fixture.history), cursor) : visible;
        runner.form = cap(visible, done, history);
      };
      draw();
      runner.onFormWrite = ({ key }) => {
        if (key === 'Down') cursor++;
        if (key === 'Up') cursor--;
        if (key === 'Enter') done = true;
        draw();
      };
      const { host, ferret } = await boot(runner);
      const q = JSON.parse(host.state('conversation').raw(QUESTION_STATE, ferret)!);
      q.text = fixture.q;
      q.header = fixture.header;
      q.options = fixture.opts.map(label => ({ label }));
      host.state('conversation').plant(QUESTION_STATE, JSON.stringify(q), ferret);
      try {
        const res = await answer(host, ferret, { toolUseId: 'toolu_1', labels: [fixture.opts[selection]] });
        expect(res.status).toBe(200);
        expect(done).toBe(true);
        expect(host.state('conversation').raw(QUESTION_ANSWERED_STATE, ferret)).toContain('toolu_1');
      } finally {
        await host.stop();
      }
    });
for (const text of [
  'Ask  the on-call first',
  'Ask\tthe on-call first',
  'Ask\n the on-call first',
  'Réviser 日本語 🚀 before approval',
])
  test(`rv5 recorded native inline row accepts ${JSON.stringify(text)}`, async () => {
    const runner = new FakeRunner();
    let cursor = 0;
    let done = false;
    let pasted: string | undefined;
    const draw = () => {
      let visible = cursorAt(read('claude-2.1.281-single-80x24'), cursor);
      if (pasted !== undefined) visible = visible.replace('Type something.', pasted);
      runner.form = cap(done ? '> ' : visible, done);
    };
    draw();
    runner.onFormWrite = ({ key, text }) => {
      if (key === 'Down') cursor++;
      if (text !== undefined) pasted = text;
      if (key === 'Enter') done = true;
      draw();
    };
    const { host, ferret } = await boot(runner);
    const q = JSON.parse(host.state('conversation').raw(QUESTION_STATE, ferret)!);
    q.text = claudeQ;
    q.header = 'Pool check';
    q.options = claudeOptions.map(label => ({ label }));
    host.state('conversation').plant(QUESTION_STATE, JSON.stringify(q), ferret);
    try {
      const res = await answer(host, ferret, { toolUseId: 'toolu_1', labels: [], other: text });
      expect(res.status).toBe(200);
      expect(runner.formPastes.map(x => x.text)).toEqual([text]);
      expect(done).toBe(true);
    } finally {
      await host.stop();
    }
  });
test('rv5 ordinary Codex free form uses the recorded note suffix, not the synthetic Other page', async () => {
  const runner = new FakeRunner();
  let cursor = 0;
  let notes = false,
    done = false;
  let pasted: string | undefined;
  const form = read('codex-0.156.1-single-80x24');
  const suffix = read('codex-0.156.1-notes-open');
  const marker = suffix.split('\n')[0]!;
  const fullNotes = form.slice(0, form.indexOf(marker)) + suffix;
  const draw = () => {
    let visible = cursorAt(notes ? fullNotes : form, cursor);
    if (pasted) visible = visible.replace('Add notes', pasted);
    runner.form = cap(done ? '> ' : visible, done);
  };
  draw();
  runner.onFormWrite = ({ key, text }) => {
    if (key === 'Down') cursor++;
    if (key === 'Tab') notes = true;
    if (text !== undefined) pasted = text;
    if (key === 'Enter') done = true;
    draw();
  };
  const { host, ferret } = await boot(runner);
  const q = JSON.parse(host.state('conversation').raw(QUESTION_STATE, ferret)!);
  q.text = codexQ;
  q.options = codexOptions.map(label => ({ label }));
  host.state('conversation').plant(QUESTION_STATE, JSON.stringify(q), ferret);
  try {
    const res = await answer(host, ferret, { toolUseId: 'toolu_1', labels: [], other: 'Ask  the on-call first' });
    expect(res.status).toBe(200);
    expect(notes).toBe(true);
    expect(pasted).toBe('Ask  the on-call first');
    expect(done).toBe(true);
  } finally {
    await host.stop();
  }
});
test('rv5 supported synthetic plain-Other page still completes through the real guard', async () => {
  const runner = new FakeRunner();
  let cursor = 0;
  let page = false,
    done = false;
  let pasted: string | undefined;
  const draw = () => {
    const visible = done
      ? '> '
      : page
        ? `Deploy?\n\nType your answer: ${pasted ?? '█'}`
        : frame(['Yes', 'No', 'Other…'], cursor);
    runner.form = cap(visible, done);
  };
  draw();
  runner.onFormWrite = ({ key, text }) => {
    if (key === 'Down') cursor++;
    if (text !== undefined) pasted = text;
    if (key === 'Enter') {
      if (page) done = true;
      else page = true;
    }
    draw();
  };
  const { host, ferret } = await boot(runner);
  try {
    const res = await answer(host, ferret, { toolUseId: 'toolu_1', labels: [], other: 'Ask first' });
    expect(res.status).toBe(200);
    expect(done).toBe(true);
    expect(pasted).toBe('Ask first');
  } finally {
    await host.stop();
  }
});
