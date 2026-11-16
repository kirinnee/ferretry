import { describe, expect, test } from 'bun:test';
import { WorkIndex } from '../../../daemon/search/lib/work-index.ts';
import { askWork, cardWork, DAY_MS, doc, NOW_MS, query } from '../../support/work.ts';

const indexOf = (...works: Parameters<typeof doc>[0][]) => {
  const index = new WorkIndex();
  for (const work of works) index.put(doc(work));
  return index;
};
const ids = (index: WorkIndex, q: string, rest: Parameters<typeof query>[1] = {}) =>
  index.search(query(q, rest), NOW_MS).hits.map(hit => hit.id);

describe('the work search index', () => {
  test('finds a card by words only in its summary and says the summary matched', () => {
    const index = indexOf(
      cardWork({ id: 'F1', title: 'Board store', fields: { summary: 'one inverted index over every card' } }),
      cardWork({ id: 'F2', title: 'Lane sets' }),
    );
    const result = index.search(query('inverted index'), NOW_MS);
    expect(result.hits.map(hit => hit.id)).toEqual(['F1']);
    expect(result.hits[0]?.match).toEqual({ field: 'summary', line: 'one inverted index over every card' });
    expect(result.total).toBe(1);
  });

  test('finds a card by words only in its progress', () => {
    const index = indexOf(
      cardWork({ id: 'F1', title: 'Board store', fields: { progress: 'wiring the quokka route' } }),
      cardWork({ id: 'F2', title: 'Lane sets' }),
    );
    expect(index.search(query('quokka'), NOW_MS).hits.map(hit => [hit.id, hit.match.field])).toEqual([
      ['F1', 'progress'],
    ]);
  });

  test('an exact id beats any text, with or without its sigil', () => {
    const index = indexOf(
      cardWork({ id: 'F12', title: 'Board store' }),
      cardWork({ id: 'F3', title: 'Mentions F12 in passing', fields: { summary: 'see F12' } }),
    );
    for (const q of ['F12', '&F12', '#F12']) expect(ids(index, q)[0]).toBe('F12');
  });

  test('an ask is found by words in its body and says whose it is', () => {
    const index = indexOf(
      askWork({
        id: 'A3',
        title: 'Relay drops',
        ferret: 'lead',
        fields: { body: 'the relay drops sessions after a deploy' },
      }),
    );
    const hit = index.search(query('deploy'), NOW_MS).hits[0];
    expect(hit?.kind).toBe('ask');
    expect(hit && hit.kind === 'ask' && hit.ferret).toBe('lead');
  });

  test('every word must match somewhere and the last is a prefix', () => {
    const index = indexOf(
      cardWork({ id: 'F1', title: 'Relay carrier' }),
      cardWork({ id: 'F2', title: 'Relay pairing' }),
      cardWork({ id: 'F3', title: 'Pairing codes' }),
    );
    expect(ids(index, 'relay pair')).toEqual(['F2']);
    expect(ids(index, 'pairing').sort()).toEqual(['F2', 'F3']);
  });

  test('kind, open and project narrow the answer', () => {
    const index = indexOf(
      cardWork({ id: 'F1', title: 'Search cards', project: 'p1' }),
      cardWork({ id: 'F2', title: 'Search more', project: 'p2', state: 'closed' }),
      askWork({ id: 'A1', title: 'Search everything' }),
    );
    expect(ids(index, 'search', { kind: 'ask' })).toEqual(['A1']);
    expect(ids(index, 'search', { open: true }).sort()).toEqual(['A1', 'F1']);
    expect(ids(index, 'search', { project: 'p2' }).sort()).toEqual(['A1', 'F2']);
  });

  test('closed work past the window is hidden and counted, unless all is asked or an exact id names it', () => {
    const old = NOW_MS - 90 * DAY_MS;
    const index = indexOf(
      cardWork({ id: 'F1', title: 'Relay rollout', state: 'closed', updatedAtMs: old }),
      cardWork({ id: 'F2', title: 'Relay' }),
    );
    const hidden = index.search(query('relay'), NOW_MS);
    expect(hidden.hits.map(hit => hit.id)).toEqual(['F2']);
    expect(hidden.olderHidden).toBe(1);
    expect(ids(index, 'relay', { all: true }).sort()).toEqual(['F1', 'F2']);
    expect(ids(index, 'F1')).toEqual(['F1']);
  });

  test('counts what it holds by kind and forgets a removed document', () => {
    const index = indexOf(cardWork({ id: 'F1', title: 'One' }), askWork({ id: 'A1', title: 'Two' }));
    expect(index.size).toEqual({ cards: 1, asks: 1 });
    index.remove('card:F1');
    expect(index.size).toEqual({ cards: 0, asks: 1 });
    expect(ids(index, 'one')).toEqual([]);
  });

  test('a related check calls a near-identical title strong', () => {
    const index = indexOf(
      cardWork({ id: 'F1', title: 'Agenda focus view' }),
      cardWork({ id: 'F2', title: 'Something else entirely' }),
    );
    const matches = index.related('Agenda focus view', '', NOW_MS, 5);
    expect(matches[0]?.hit.id).toBe('F1');
    expect(matches[0]?.strength).toBe('strong');
  });
});

describe('the rarity a related check gives the words it did not re-scrub', () => {
  const index = () =>
    indexOf(
      cardWork({ id: 'F1', title: 'Quokka widget' }),
      cardWork({ id: 'F2', title: 'Widget polish' }),
      cardWork({ id: 'F3', title: 'Widget colours' }),
    );
  const scoreOf = (rarity: 'index' | 'unknown') => {
    const built = index();
    const documents = new Map([['card:F1', doc(cardWork({ id: 'F1', title: 'Quokka widget' }))]]);
    return built.relatedAmong('Quokka', '', NOW_MS, 5, documents, rarity).map(match => match.hit.score);
  };

  test('G164 unknown weighs an unasked word as if no other item held it; index uses the index count', () => {
    // `widget` is held by three items: by the index it is common, so F1's body leans on `quokka` more.
    const [byIndex] = scoreOf('index');
    const [unknown] = scoreOf('unknown');
    expect(byIndex).toBeGreaterThan(unknown ?? 0);
  });
});

describe('the line a hit shows', () => {
  test('falls back to the title when the words matched only the id', () => {
    const index = indexOf(cardWork({ id: 'F1', title: 'Board store' }));
    const hit = index.search(query('F1 F1'), NOW_MS).hits[0];
    expect(hit?.match).toEqual({ field: 'title', line: 'Board store' });
  });
});
