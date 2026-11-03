import { describe, expect, test } from 'bun:test';
import type { AgendaItem, AgendaVersionSummary } from '@ferretry/protocol';
import {
  BASIS_WORDS,
  changedSections,
  defaultComparison,
  diffItems,
  diffSummary,
  diffWords,
  orderedPair,
  sectionText,
  versionLabel,
  type WordRun,
} from '../../src/lib/agenda-diff.ts';
import { agendaItem } from '../support/agenda-inbox.tsx';

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
    const runs = diffWords('a b c d e f', 'a x c d y f');
    expect(words(runs, 'removed')).toEqual(['b', 'e']);
    expect(words(runs, 'added')).toEqual(['x', 'y']);
    expect(words(runs, 'same').join(' ')).toContain('c d');
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

  test('leaves out a section neither version has, and keeps reading order', () => {
    const keys = diffItems(before, after).map(section => section.key);
    expect(keys).not.toContain('steps');
    expect(keys.indexOf('title')).toBeLessThan(keys.indexOf('whereWeAre'));
    expect(keys.indexOf('whereWeAre')).toBeLessThan(keys.indexOf('ask'));
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
    expect(changedSections(diff).map(section => section.key)).toEqual(['terms', 'whereWeAre', 'ask', 'body']);
    expect(diffSummary(diff)).toMatch(/^4 sections changed · \+\d+ words · −\d+ words?$/u);
    expect(diffSummary(diffItems(before, before))).toBe('Nothing changed');
    expect(diffSummary(diffItems(item({ title: 'A' }), item({ title: 'A b' })))).toBe(
      '1 section changed · +1 word · −0 words',
    );
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
