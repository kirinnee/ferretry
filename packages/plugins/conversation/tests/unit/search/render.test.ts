import { describe, expect, test } from 'bun:test';
import type { WorkHit, WorkSearchResponse } from '../../../contract/index.ts';
import { renderSearch } from '../../../daemon/search/lib/render.ts';

const hit = (partial: Record<string, unknown>): WorkHit =>
  ({
    kind: 'card',
    id: 'F1',
    title: 'Relay carrier',
    standing: 'Todo',
    match: { field: 'summary', line: 'the relay carrier choice' },
    score: 1,
    ...partial,
  }) as unknown as WorkHit;

const answer = (hits: WorkHit[], rest: Partial<WorkSearchResponse> = {}): WorkSearchResponse =>
  ({ hits, total: hits.length, indexed: { cards: 0, asks: 0 }, ...rest }) as WorkSearchResponse;

describe('renderSearch', () => {
  test('says which kind matched nothing, and how many older closed items were left out', () => {
    expect(renderSearch('relay', undefined, answer([]))).toBe('No cards or asks match “relay”.');
    expect(renderSearch('relay', 'card', answer([]))).toBe('No cards match “relay”.');
    expect(renderSearch('relay', 'ask', answer([], { olderHidden: 1 }))).toBe(
      'No asks match “relay”.\n1 older closed item hidden — search_work again with all: true',
    );
    expect(renderSearch('relay', 'ask', answer([], { olderHidden: 3 }))).toContain('3 older closed items hidden');
    expect(renderSearch('relay', 'ask', answer([], { olderHidden: 0 }))).toBe('No asks match “relay”.');
  });

  test('draws one line per hit: reference, kind, standing, owner of an ask, title, and the line that matched', () => {
    const text = renderSearch(
      'relay',
      undefined,
      answer([
        hit({}),
        hit({
          kind: 'ask',
          id: 'A3',
          ferret: 'zoe',
          standing: 'open',
          title: 'Which relay?',
          match: { field: 'ask', line: 'a long\n  question' },
        }),
      ]),
    );
    expect(text.split('\n')).toEqual([
      '&F1 card [Todo] Relay carrier — the relay carrier choice',
      '!A3 ask [open] (ask of zoe) Which relay? — a long question',
    ]);
  });

  test('shows no matching line when it is only the id, the title, empty, or the title again; and cuts a long one', () => {
    const lines = renderSearch(
      'x',
      undefined,
      answer([
        hit({ match: { field: 'id', line: 'Relay carrier' } }),
        hit({ match: { field: 'title', line: 'Relay carrier' } }),
        hit({ match: { field: 'summary', line: '   ' } }),
        hit({ match: { field: 'summary', line: ' Relay   carrier ' } }),
        hit({ match: { field: 'summary', line: 'w'.repeat(300) } }),
      ]),
    ).split('\n');
    expect(lines.slice(0, 4).every(line => line === '&F1 card [Todo] Relay carrier')).toBe(true);
    expect(lines[4]?.endsWith('…')).toBe(true);
    expect(lines[4]?.length).toBeLessThan(160);
  });

  test('says when only some of the hits are shown, and how many older closed items are hidden', () => {
    const text = renderSearch('relay', undefined, answer([hit({})], { total: 5, olderHidden: 2 }));
    expect(text.split('\n').slice(1)).toEqual([
      '(1 of 5 shown; narrow it with kind or open)',
      '2 older closed items hidden — search_work again with all: true',
    ]);
  });
});
