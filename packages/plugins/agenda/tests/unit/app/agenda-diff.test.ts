import { describe, expect, test } from 'bun:test';
import type { AgendaItem, AgendaVersionSummary } from '@ferretry/core-asks/contract';
import {
  BASIS_WORDS,
  bagSimilarity,
  changedSections,
  defaultComparison,
  diffItems,
  diffSummary,
  diffText,
  diffWords,
  foldUnchanged,
  orderedPair,
  REWRITE_SIMILARITY,
  sectionText,
  similarity,
  versionLabel,
  type WordRun,
} from '../../../app/lib/agenda-diff.ts';
import { agendaItem } from '../../support/app/agenda-inbox.tsx';

const item = (overrides: Partial<AgendaItem> = {}): AgendaItem => agendaItem('A5', overrides);

const words = (runs: readonly WordRun[], kind: WordRun['kind']): string[] =>
  runs.filter(run => run.kind === kind).map(run => run.text.trim());

describe('the word diff', () => {
  test('keeps what did not change and marks the words added and removed', () => {
    const runs = diffWords('The deploy waits on review', 'The deploy waits on two reviews');
    expect(words(runs, 'removed')).toEqual(['review']);
    expect(words(runs, 'added')).toEqual(['two reviews']);
    expect(runs.map(run => run.text).join('')).toContain('The deploy waits on ');
  });

  test('reads the same text as one kept run, and nothing as no runs', () => {
    expect(diffWords('same words', 'same words')).toEqual([{ kind: 'same', text: 'same words' }]);
    expect(diffWords('', '')).toEqual([]);
  });

  test('draws a text that appeared as all added and one that vanished as all removed', () => {
    expect(diffWords('', 'new text')).toEqual([{ kind: 'added', text: 'new text' }]);
    expect(diffWords('old text', '')).toEqual([{ kind: 'removed', text: 'old text' }]);
  });

  test('finds the longest common words in the middle of an edit', () => {
    const runs = diffWords('alpha bravo charlie delta echo foxtrot', 'alpha xray charlie delta yankee foxtrot');
    expect(words(runs, 'removed')).toEqual(['bravo', 'echo']);
    expect(words(runs, 'added')).toEqual(['xray', 'yankee']);
    expect(words(runs, 'same').join(' ')).toContain('charlie delta');
  });

  test('folds a short kept word between two changes into them, so one edit is not confetti', () => {
    expect(diffWords('alpha the bravo', 'gamma the delta')).toEqual([
      { kind: 'removed', text: 'alpha the bravo' },
      { kind: 'added', text: 'gamma the delta' },
    ]);
    expect(diffWords('alpha is bravo', 'gamma is delta')).toEqual([
      { kind: 'removed', text: 'alpha is bravo' },
      { kind: 'added', text: 'gamma is delta' },
    ]);
  });

  test('keeps a longer kept run between two changes as it was', () => {
    const runs = diffWords('alpha remains steady bravo', 'gamma remains steady delta');
    expect(words(runs, 'same')).toEqual(['remains steady']);
    expect(words(runs, 'removed')).toEqual(['alpha', 'bravo']);
  });

  test('tells a pure insertion from a pure removal in the middle', () => {
    expect(words(diffWords('one three', 'one two three'), 'added')).toEqual(['two']);
    expect(words(diffWords('one two three', 'one three'), 'removed')).toEqual(['two']);
  });

  test('rebuilds both texts exactly from its runs', () => {
    const before = 'Pick Redis for the queue.\nIt is faster.';
    const after = 'Pick Postgres for the queue.\nIt is simpler and already here.';
    const runs = diffWords(before, after);
    expect(
      runs
        .filter(run => run.kind !== 'added')
        .map(run => run.text)
        .join(''),
    ).toBe(before);
    expect(
      runs
        .filter(run => run.kind !== 'removed')
        .map(run => run.text)
        .join(''),
    ).toBe(after);
  });

  test('shows a very long edit as the old text out and the new text in rather than comparing every pair', () => {
    const before = Array.from({ length: 2500 }, (_, index) => `a${String(index)}`).join(' ');
    const after = Array.from({ length: 2500 }, (_, index) => `b${String(index)}`).join(' ');
    const runs = diffWords(before, after);
    expect(runs.map(run => run.kind)).toEqual(['removed', 'added']);
  });
});

describe('how alike two texts are', () => {
  test('counts the words two texts share in order, never the spaces', () => {
    expect(similarity('a b', 'a b')).toBe(1);
    expect(similarity('', '')).toBe(1);
    expect(similarity('a', '')).toBe(0);
    expect(similarity('', 'a')).toBe(0);
    expect(similarity('x   y', 'x y')).toBe(1);
    expect(similarity('the cat sat', 'the dog sat')).toBeCloseTo(4 / 6, 5);
    expect(similarity('a b c', 'c b a')).toBeCloseTo(2 / 6, 5);
  });
});

describe('the text diff: lines, then sentences, then words', () => {
  test('shows a rewrite as the old block out and the new block in, never woven word by word', () => {
    const before = 'I am reading how the Inbox counts the badge.';
    const after = 'The badge counts every open agenda that waits.';
    expect(similarity(before, after)).toBeLessThan(REWRITE_SIMILARITY);
    expect(diffText(before, after)).toEqual([
      { kind: 'removed', text: before },
      { kind: 'added', text: after },
    ]);
  });

  test('keeps a small edit at the word level, on the line either side of the threshold', () => {
    expect(REWRITE_SIMILARITY).toBe(0.5);
    const edit = diffText('aa bb cc dd', 'aa bb xx yy');
    expect(similarity('aa bb cc dd', 'aa bb xx yy')).toBe(REWRITE_SIMILARITY);
    expect(edit).toEqual([
      { kind: 'same', text: 'aa bb ' },
      { kind: 'removed', text: 'cc dd' },
      { kind: 'added', text: 'xx yy' },
    ]);
    const rewrite = diffText('aa bb cc dd', 'aa xx yy zz');
    expect(similarity('aa bb cc dd', 'aa xx yy zz')).toBeLessThan(REWRITE_SIMILARITY);
    expect(rewrite).toEqual([
      { kind: 'removed', text: 'aa bb cc dd' },
      { kind: 'added', text: 'aa xx yy zz' },
    ]);
  });

  test('pairs the changed lines, words inside an alike pair and a whole block for a line with no partner', () => {
    const before = 'Choose one\n- Ship it: now\n- Wait: for review';
    const after = 'Choose one\n- Ship it: today\n- Hold off until the owner answers';
    expect(diffText(before, after)).toEqual([
      { kind: 'same', text: 'Choose one\n- Ship it: ' },
      { kind: 'removed', text: 'now' },
      { kind: 'added', text: 'today' },
      { kind: 'same', text: '\n' },
      { kind: 'removed', text: '- Wait: for review' },
      { kind: 'added', text: '- Hold off until the owner answers' },
    ]);
  });

  test('keeps a line that moved out of the way of the pairing: a line added or removed whole', () => {
    expect(diffText('- One\n- Two\n', '- One\n- Two\n- Three and more\n')).toEqual([
      { kind: 'same', text: '- One\n- Two\n' },
      { kind: 'added', text: '- Three and more\n' },
    ]);
    expect(diffText('- One\n- Two\n- Three and more\n', '- One\n- Three and more\n')).toEqual([
      { kind: 'same', text: '- One\n' },
      { kind: 'removed', text: '- Two\n' },
      { kind: 'same', text: '- Three and more\n' },
    ]);
  });

  test('compares a line sentence by sentence: the sentence kept stays, the sentence rewritten is a block', () => {
    const before = 'The queue is Postgres. It is simpler and already here.';
    const after = 'The queue is Postgres. We chose it because nothing else needs running.';
    expect(diffText(before, after)).toEqual([
      { kind: 'same', text: 'The queue is Postgres. ' },
      { kind: 'removed', text: 'It is simpler and already here.' },
      { kind: 'added', text: 'We chose it because nothing else needs running.' },
    ]);
  });

  test('rebuilds both texts exactly from its runs, over lines and sentences', () => {
    const before = 'Pick Redis for the queue. It is fast.\n- Wait: for review\nLast line';
    const after = 'Pick Postgres for the queue. It is simpler.\n- Hold off\nLast line stays';
    const runs = diffText(before, after);
    expect(
      runs
        .filter(run => run.kind !== 'added')
        .map(run => run.text)
        .join(''),
    ).toBe(before);
    expect(
      runs
        .filter(run => run.kind !== 'removed')
        .map(run => run.text)
        .join(''),
    ).toBe(after);
  });

  test('reads the same text as one kept run', () => {
    expect(diffText('same\ntext', 'same\ntext')).toEqual([{ kind: 'same', text: 'same\ntext' }]);
  });

  test('shows a thousand lines against a thousand others as the old block out and the new block in', () => {
    const lines = (prefix: string) =>
      Array.from({ length: 1000 }, (_, index) => `${prefix}${String(index)}\n`).join('');
    expect(diffText(lines('a'), lines('b')).map(run => run.kind)).toEqual(['removed', 'added']);
  });
});

describe('a long text with a small edit', () => {
  const report = (count: number, edit: Readonly<Record<number, string>>): string =>
    Array.from(
      { length: count },
      (_, index) => `${edit[index] ?? `Step ${String(index)} of the report finished cleanly`}\n`,
    ).join('');
  const joined = (runs: ReturnType<typeof diffText>, drop: 'added' | 'removed'): string =>
    runs
      .filter(run => run.kind !== drop)
      .map(run => run.text)
      .join('');

  test.each([60, 1000])('keeps %i lines with one word changed word-level', count => {
    const before = report(count, {});
    const after = report(count, {
      [Math.floor(count / 2)]: `Step ${String(Math.floor(count / 2))} of the report failed cleanly`,
    });
    const runs = diffText(before, after);
    expect(runs.filter(run => run.kind === 'removed').map(run => run.text)).toEqual(['finished']);
    expect(runs.filter(run => run.kind === 'added').map(run => run.text)).toEqual(['failed']);
    expect(joined(runs, 'added')).toBe(before);
    expect(joined(runs, 'removed')).toBe(after);
  });

  test('anchors on equal lines when edits lie far apart in a long text', () => {
    const before = report(1000, {});
    const after = report(1000, {
      100: 'Step 100 of the report failed cleanly',
      900: 'Step 900 of the report failed cleanly',
    });
    const runs = diffText(before, after);
    expect(runs.filter(run => run.kind === 'removed').map(run => run.text)).toEqual(['finished', 'finished']);
    expect(joined(runs, 'added')).toBe(before);
    expect(joined(runs, 'removed')).toBe(after);
  });

  test('keeps a sixty sentence paragraph with one word changed word-level', () => {
    const paragraph = (word: string): string =>
      Array.from(
        { length: 60 },
        (_, index) => `Sentence ${String(index)} ${index === 30 ? word : 'holds'} steady.`,
      ).join(' ');
    const runs = diffText(paragraph('holds'), paragraph('wobbles'));
    expect(runs.filter(run => run.kind === 'removed').map(run => run.text)).toEqual(['holds']);
    expect(runs.filter(run => run.kind === 'added').map(run => run.text)).toEqual(['wobbles']);
  });

  test('pairs the gaps between anchors under their own cap, and shows a gap too large as a block', () => {
    const lines = (prefix: string, count: number): string =>
      Array.from({ length: count }, (_, index) => `${prefix}${String(index)}\n`).join('');
    const before = `keep\n${lines('a', 100)}keep too\n${lines('c', 100)}`;
    const after = `keep\n${lines('b', 100)}keep too\n${lines('d', 100)}`;
    const runs = diffText(before, after);
    expect(runs.map(run => run.kind)).toEqual(['same', 'removed', 'added', 'same', 'removed', 'added']);
    expect(joined(runs, 'added')).toBe(before);
    expect(joined(runs, 'removed')).toBe(after);
  });
});

describe('a very long text', () => {
  const lines = (count: number, edit: Readonly<Record<number, string>>): string =>
    Array.from(
      { length: count },
      (_, index) => `${edit[index] ?? `Step ${String(index)} of the report finished cleanly`}\n`,
    ).join('');
  const sentences = (count: number, edit: Readonly<Record<number, string>>): string =>
    Array.from({ length: count }, (_, index) => `Sentence ${String(index)} ${edit[index] ?? 'holds'} steady.`).join(
      ' ',
    );
  const joined = (runs: ReturnType<typeof diffText>, drop: 'added' | 'removed'): string =>
    runs
      .filter(run => run.kind !== drop)
      .map(run => run.text)
      .join('');

  test('keeps two one-word edits at the two ends of 3000 lines word-level', () => {
    const before = lines(3000, {});
    const after = lines(3000, {
      2: 'Step 2 of the report failed cleanly',
      2597: 'Step 2597 of the report failed cleanly',
    });
    const started = performance.now();
    const runs = diffText(before, after);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(runs.filter(run => run.kind === 'removed').map(run => run.text)).toEqual(['finished', 'finished']);
    expect(runs.filter(run => run.kind === 'added').map(run => run.text)).toEqual(['failed', 'failed']);
    expect(joined(runs, 'added')).toBe(before);
    expect(joined(runs, 'removed')).toBe(after);
  });

  test('keeps the text whole when two far lines swap places in 3000 lines', () => {
    const before = lines(3000, {});
    const after = lines(3000, {
      10: 'Step 2500 of the report finished cleanly',
      2500: 'Step 10 of the report finished cleanly',
    });
    const runs = diffText(before, after);
    expect(joined(runs, 'added')).toBe(before);
    expect(joined(runs, 'removed')).toBe(after);
    expect(runs.some(run => run.kind !== 'added' && run.kind !== 'removed' && run.text.length > 50_000)).toBe(true);
  });

  test('keeps two far edits in a 3000 sentence paragraph word-level', () => {
    const before = sentences(3000, {});
    const after = sentences(3000, { 5: 'wobbles', 2990: 'wobbles' });
    const started = performance.now();
    const runs = diffText(before, after);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(runs.filter(run => run.kind === 'removed').map(run => run.text)).toEqual(['holds', 'holds']);
    expect(runs.filter(run => run.kind === 'added').map(run => run.text)).toEqual(['wobbles', 'wobbles']);
    expect(joined(runs, 'added')).toBe(before);
    expect(joined(runs, 'removed')).toBe(after);
  });

  test('keeps far edits word-level in one line of 6000 words', () => {
    const words = (edit: Readonly<Record<number, string>>): string =>
      Array.from({ length: 6000 }, (_, index) => edit[index] ?? `w${String(index)}`).join(' ');
    const before = words({});
    const after = words({ 10: 'changed', 5900: 'altered' });
    const runs = diffWords(before, after);
    expect(runs.filter(run => run.kind === 'removed').map(run => run.text)).toEqual(['w10', 'w5900']);
    expect(runs.filter(run => run.kind === 'added').map(run => run.text)).toEqual(['changed', 'altered']);
  });

  test('answers a 50 by 50 block of 500-word lines, all rewritten, within a bound', () => {
    const block = (prefix: string): string =>
      Array.from(
        { length: 50 },
        (_, line) =>
          `${Array.from({ length: 500 }, (_, word) => `${prefix}${String(line)}x${String(word)}`).join(' ')}\n`,
      ).join('');
    const before = block('a');
    const after = block('b');
    const started = performance.now();
    const runs = diffText(before, after);
    expect(performance.now() - started).toBeLessThan(1500);
    expect(joined(runs, 'added')).toBe(before);
    expect(joined(runs, 'removed')).toBe(after);
  });

  test('still pairs alike lines once the exact scoring budget is spent', () => {
    const block = (word: string): string =>
      Array.from(
        { length: 50 },
        (_, line) =>
          `${Array.from({ length: 500 }, (_, index) => (index === 250 ? word : `l${String(line)}w${String(index)}`)).join(' ')}\n`,
      ).join('');
    const before = block('old');
    const after = block('new');
    const started = performance.now();
    const runs = diffText(before, after);
    expect(performance.now() - started).toBeLessThan(1500);
    expect(runs.filter(run => run.kind === 'removed').every(run => run.text === 'old')).toBe(true);
    expect(joined(runs, 'added')).toBe(before);
    expect(joined(runs, 'removed')).toBe(after);
  });

  test('scores two texts by their bag of words', () => {
    expect(bagSimilarity('', '')).toBe(1);
    expect(bagSimilarity('a', '')).toBe(0);
    expect(bagSimilarity('', 'a')).toBe(0);
    expect(bagSimilarity('a b c', 'c b a')).toBe(1);
    expect(bagSimilarity('a a b', 'a b b')).toBeCloseTo(4 / 6, 5);
  });
});

describe('folding what did not change', () => {
  const lines = (from: number, to: number): string =>
    Array.from({ length: to - from }, (_, index) => `line ${String(from + index)}\n`).join('');

  test('cuts a long unchanged stretch to the lines beside each change and says how many it hides', () => {
    const before = `${lines(0, 100)}old word\n${lines(101, 200)}`;
    const after = `${lines(0, 100)}new word\n${lines(101, 200)}`;
    const folded = foldUnchanged(diffText(before, after));
    expect(folded.map(run => (run.kind === 'folded' ? `… ${String(run.lines)}` : run.kind))).toEqual([
      '… 97',
      'same',
      'removed',
      'added',
      'same',
      '… 97',
    ]);
    expect(folded.filter(run => run.kind === 'same').map(run => (run as WordRun).text)).toEqual([
      'line 97\nline 98\nline 99\n',
      ' word\nline 101\nline 102\n',
    ]);
  });

  test('folds between two far changes too, and leaves a short stretch whole', () => {
    const before = `a one\n${lines(0, 50)}b one\n${lines(50, 54)}c one\n`;
    const after = `a two\n${lines(0, 50)}b two\n${lines(50, 54)}c two\n`;
    const folded = foldUnchanged(diffText(before, after));
    expect(folded.filter(run => run.kind === 'folded').map(run => (run as { lines: number }).lines)).toEqual([46]);
    expect(folded.some(run => run.kind === 'same' && run.text.includes('line 51'))).toBe(true);
  });

  test('leaves a text with nothing changed whole', () => {
    const same = diffText(lines(0, 100), lines(0, 100));
    expect(foldUnchanged(same)).toEqual(same);
  });
});

describe('the sections of an item as text', () => {
  test('says the ask by its kind and options, terms and references one a line', () => {
    const choice = item({
      ask: { kind: 'multiple-choice', options: [{ label: 'Ship it', description: 'now' }, { label: 'Wait' }] },
    } as Partial<AgendaItem>);
    expect(sectionText(choice, 'ask')).toBe('Choose one\n- Ship it: now\n- Wait');
    expect(sectionText(item({ ask: { kind: 'task' } } as Partial<AgendaItem>), 'ask')).toBe('Do this');
    expect(sectionText(item({ ask: { kind: 'permission' } } as Partial<AgendaItem>), 'ask')).toBe('Allow or deny');
    expect(sectionText(item({ ask: undefined }), 'ask')).toBe('');
    const rich = item({
      terms: [{ term: 'Merge queue', meaning: 'Lands PRs one by one' }],
      links: [{ target: '!A3', label: 'The parent', meaning: 'Where this came from' }, { target: '&F12' }],
      steps: ['Open the PR', 'Press merge'],
      context: '  The facts  ',
    } as Partial<AgendaItem>);
    expect(sectionText(rich, 'terms')).toBe('Merge queue: Lands PRs one by one');
    expect(sectionText(rich, 'links')).toBe('The parent · !A3 · Where this came from\n&F12');
    expect(sectionText(rich, 'steps')).toBe('1. Open the PR\n2. Press merge');
    expect(sectionText(rich, 'context')).toBe('The facts');
    expect(sectionText(item({ context: null }), 'context')).toBe('');
  });

  test('says the type, the questions, the option details, the form and the cards one entry a line', () => {
    expect(sectionText(item({ stage: 'plan' }), 'stage')).toBe('Plan to approve');
    expect(sectionText(item({ stage: 'tracker' }), 'stage')).toBe('Tracker');
    const rich = item({
      questions: [
        { question: 'Which queue?', options: [{ label: 'Redis' }, { label: 'Postgres' }], recommended: 'Postgres' },
        { question: 'By when?' },
      ],
      optionDetails: [{ label: 'Redis', detail: 'Fast,\n  but another thing to run.' }],
      fields: [
        { id: 'region', type: 'one', label: 'Region', options: [{ label: 'EU' }, { label: 'US' }] },
        { id: 'note', type: 'text', label: 'A note', required: false },
        { id: 'ok', type: 'yesno', label: 'Fine?' },
      ],
      cards: [{ task: { id: 'F12' }, line: 'Wire it in' }],
    } as unknown as Partial<AgendaItem>);
    expect(sectionText(rich, 'questions')).toBe(
      '1. Which queue? · Options: Redis / Postgres · Recommended: Postgres\n2. By when?',
    );
    expect(sectionText(rich, 'optionDetails')).toBe('Redis: Fast, but another thing to run.');
    expect(sectionText(rich, 'fields')).toBe(
      'Region (pick one) · Options: EU / US\nA note (in words, optional)\nFine? (yes or no)',
    );
    expect(sectionText(rich, 'cards')).toBe('&F12 Wire it in');
    expect(sectionText(item(), 'questions')).toBe('');
  });

  test('reads a structured recommendation as its text fields and anything else it cannot as empty', () => {
    const recommended = item({
      recommendation: { decision: 'Ship it', reason: 'The tests pass' },
    } as unknown as Partial<AgendaItem>);
    expect(sectionText(recommended, 'recommendation')).toBe('Ship it\nThe tests pass');
    expect(sectionText(item(), 'recommendation')).toBe('');
    const odd = item({ recommendation: 'Just ship' } as unknown as Partial<AgendaItem>);
    expect(sectionText(odd, 'recommendation')).toBe('Just ship');
    const counted = item({
      recommendation: { confidence: 3, firm: true, nested: {} },
    } as unknown as Partial<AgendaItem>);
    expect(sectionText(counted, 'recommendation')).toBe('3\ntrue');
  });
});

describe('the sections compared', () => {
  const before = item({
    title: 'Pick a queue',
    whereWeAre: 'We are comparing two queues.',
    terms: [{ term: 'Queue', meaning: 'A line of jobs' }],
    ask: { kind: 'multiple-choice', options: [{ label: 'Redis' }, { label: 'Postgres' }] },
  } as Partial<AgendaItem>);
  const after = item({
    title: 'Pick a queue',
    whereWeAre: 'We chose Postgres and are wiring it in.',
    terms: [
      { term: 'Queue', meaning: 'A line of jobs' },
      { term: 'Outbox', meaning: 'Writes jobs in the same transaction' },
    ],
    ask: { kind: 'task' },
    body: 'A new report.',
  } as Partial<AgendaItem>);

  test('marks each section changed, added or removed and leaves the rest unchanged', () => {
    const diff = diffItems(before, after);
    const status = Object.fromEntries(diff.map(section => [section.key, section.status]));
    expect(status.title).toBe('unchanged');
    expect(status.whereWeAre).toBe('changed');
    expect(status.terms).toBe('changed');
    expect(status.ask).toBe('changed');
    expect(status.body).toBe('added');
    expect(diffItems(after, before).find(section => section.key === 'body')?.status).toBe('removed');
  });

  test('leaves out a section neither version has, lists the tabs first, then keeps reading order (&F923)', () => {
    const keys = diffItems(before, after).map(section => section.key);
    expect(keys).not.toContain('steps');
    expect(keys.slice(0, 2)).toEqual(['whereWeAre', 'body']);
    expect(keys.indexOf('body')).toBeLessThan(keys.indexOf('title'));
    expect(keys.indexOf('title')).toBeLessThan(keys.indexOf('ask'));
  });

  test('counts the words added and removed in a section', () => {
    const where = diffItems(before, after).find(section => section.key === 'whereWeAre');
    expect(where?.addedWords).toBeGreaterThan(0);
    expect(where?.removedWords).toBeGreaterThan(0);
    const unchanged = diffItems(before, after).find(section => section.key === 'title');
    expect(unchanged).toMatchObject({ addedWords: 0, removedWords: 0 });
  });

  test('picks out the changed sections and says what changed in one line', () => {
    const diff = diffItems(before, after);
    // The tabs lead: they are the item's live document, the thing that is versioned.
    expect(changedSections(diff).map(section => section.key)).toEqual(['whereWeAre', 'body', 'stage', 'terms', 'ask']);
    expect(diffSummary(diff)).toMatch(/^5 sections changed · \+\d+ words · −\d+ words?$/u);
    expect(diffSummary(diffItems(before, before))).toBe('Nothing changed');
    expect(diffSummary(diffItems(item({ title: 'A' }), item({ title: 'A b' })))).toBe(
      '1 section changed · +1 word · −0 words',
    );
  });

  test('shows a changed type, so Question to Plan to Tracker is never "Nothing changed"', () => {
    const question = item({ title: 'Pick a queue', stage: 'question' });
    const plan = item({ title: 'Pick a queue', stage: 'plan' });
    const diff = diffItems(question, plan);
    const stage = diff.find(section => section.key === 'stage');
    expect(stage?.status).toBe('changed');
    expect(stage?.label).toBe('Type');
    expect(stage?.runs).toEqual([
      { kind: 'removed', text: 'Question' },
      { kind: 'added', text: 'Plan to approve' },
    ]);
    expect(diffSummary(diff)).not.toBe('Nothing changed');
  });

  test('shows a replaced set of questions, a changed form, new option details and a new card', () => {
    const before = item({
      questions: [{ question: 'Which queue should the daemon use?' }],
      fields: [{ id: 'a', type: 'text', label: 'Anything to add?' }],
    } as unknown as Partial<AgendaItem>);
    const after = item({
      questions: [{ question: 'When should the migration run?' }, { question: 'Who signs it off?' }],
      fields: [{ id: 'a', type: 'text', label: 'Anything to add?', required: false }],
      optionDetails: [{ label: 'Now', detail: 'Before the weekend.' }],
      cards: [{ task: { id: 'F12' }, line: 'Wire it in' }],
    } as unknown as Partial<AgendaItem>);
    const status = Object.fromEntries(diffItems(before, after).map(section => [section.key, section.status]));
    expect(status.questions).toBe('changed');
    expect(status.fields).toBe('changed');
    expect(status.optionDetails).toBe('added');
    expect(status.cards).toBe('added');
    expect(diffSummary(diffItems(before, after))).toMatch(/^4 sections changed/u);
  });

  test('draws a rewritten section as a block out and a block in, and a one-word edit inside the line', () => {
    const before = item({
      whereWeAre: 'I am reading how the Inbox counts the badge.',
      terms: [{ term: 'Queue', meaning: 'A line of jobs' }],
    } as Partial<AgendaItem>);
    const after = item({
      whereWeAre: 'The badge counts every open agenda that waits.',
      terms: [{ term: 'Queue', meaning: 'A line of work' }],
    } as Partial<AgendaItem>);
    const diff = diffItems(before, after);
    expect(diff.find(section => section.key === 'whereWeAre')?.runs.map(run => run.kind)).toEqual(['removed', 'added']);
    const terms = diff.find(section => section.key === 'terms');
    expect(words(terms?.runs ?? [], 'removed')).toEqual(['jobs']);
    expect(words(terms?.runs ?? [], 'added')).toEqual(['work']);
  });

  test('compares any two items, not only neighbours', () => {
    const middle = item({
      title: 'Pick a queue',
      whereWeAre: 'We are comparing two queues.',
      body: 'Draft',
    } as Partial<AgendaItem>);
    expect(diffItems(before, middle).find(section => section.key === 'body')?.status).toBe('added');
    expect(diffItems(middle, after).find(section => section.key === 'body')?.status).toBe('changed');
  });
});

describe('the ferret’s own tabs compared (&F923)', () => {
  const tab = (id: string, name: string, body: string) => ({ id, name, body });
  const before = item({
    whereWeAre: 'Planning.',
    tabs: [tab('decisions', 'Decisions', 'SQLite.'), tab('risks', 'Risks', 'Slip.'), tab('old', 'Old', 'Gone soon.')],
  } as unknown as Partial<AgendaItem>);
  const after = item({
    whereWeAre: 'Planning.',
    tabs: [
      tab('risks', 'Open risks', 'Slip.'),
      tab('decisions', 'Decisions', 'SQLite, with WAL.'),
      tab('notes', 'Notes', 'New.'),
    ],
  } as unknown as Partial<AgendaItem>);

  test('match by id: a rename says what it was, a new tab is added, a removed one removed, after the fixed tabs', () => {
    const diff = diffItems(before, after);
    expect(diff.slice(0, 6).map(section => [section.key, section.label, section.status])).toEqual([
      ['whereWeAre', 'Where we are now', 'unchanged'],
      ['tab:risks', 'Open risks (was Risks)', 'changed'],
      ['tab:decisions', 'Decisions', 'changed'],
      ['tab:notes', 'Notes', 'added'],
      ['tab:old', 'Old', 'removed'],
      ['tabOrder', 'Tab order', 'changed'],
    ]);
    expect(diff.find(section => section.key === 'tab:risks')).toMatchObject({ addedWords: 0, removedWords: 0 });
    expect(diffSummary(diff)).toMatch(/^5 sections changed/u);
  });

  test('say nothing of the order when the tabs both versions have kept it', () => {
    const reordered = item({
      tabs: [tab('decisions', 'Decisions', 'SQLite.'), tab('new', 'New', 'x')],
    } as unknown as Partial<AgendaItem>);
    const keys = diffItems(before, reordered).map(section => section.key);
    expect(keys).not.toContain('tabOrder');
    expect(diffItems(item(), item()).some(section => section.key.startsWith('tab'))).toBe(false);
  });
});

describe('which two versions', () => {
  test('puts the older first', () => {
    expect(orderedPair(4, 2)).toEqual({ from: 2, to: 4 });
    expect(orderedPair(2, 4)).toEqual({ from: 2, to: 4 });
    expect(orderedPair(3, 3)).toEqual({ from: 3, to: 3 });
  });

  test('defaults to since this device last looked, up to the newest', () => {
    expect(defaultComparison({ latest: 6, seen: 3 })).toEqual({ pair: { from: 3, to: 6 }, basis: 'since-seen' });
  });

  test('defaults to since it was raised for a device that never opened it', () => {
    expect(defaultComparison({ latest: 4 })).toEqual({ pair: { from: 1, to: 4 }, basis: 'never-seen' });
  });

  test('defaults to the latest change when the device has already seen the newest', () => {
    expect(defaultComparison({ latest: 4, seen: 4 })).toEqual({ pair: { from: 3, to: 4 }, basis: 'latest-change' });
    expect(defaultComparison({ latest: 4, seen: 9 })).toEqual({ pair: { from: 3, to: 4 }, basis: 'latest-change' });
  });

  test('has nothing to compare for an item with fewer than two versions', () => {
    expect(defaultComparison({ latest: 1, seen: 1 })).toBeNull();
    expect(defaultComparison({ latest: 0 })).toBeNull();
  });

  test('names each basis in the owner’s words', () => {
    expect(BASIS_WORDS['since-seen']).toBe('Since you last looked');
    expect(BASIS_WORDS['never-seen']).toBe('Since it was raised');
    expect(BASIS_WORDS['latest-change']).toBe('The latest change');
  });

  test('labels a version with its number, time, author and change', () => {
    const now = Date.parse('2026-08-01T12:00:00.000Z');
    const summary = (by: AgendaVersionSummary['by']): AgendaVersionSummary => ({
      version: 3,
      at: '2026-08-01T11:00:00.000Z',
      by,
      change: 'updated',
      lifecycle: 'active',
    });
    expect(versionLabel(summary('ferret'), now)).toMatch(/^v3 · \d{1,2}:\d\d · the ferret · updated$/u);
    expect(versionLabel(summary('owner'), now)).toContain('· you ·');
    expect(versionLabel(summary('daemon'), now)).toContain('· Ferretry ·');
  });
});
