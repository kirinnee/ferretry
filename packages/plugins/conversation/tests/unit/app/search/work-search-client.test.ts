import { describe, expect, it } from 'bun:test';
import { DaemonCallError } from '@ferretry/app';
import type { WorkHit } from '../../../../contract/index.ts';
import {
  fetchWorkSearch,
  isWorkSearchWords,
  workHitDescription,
  workHitKey,
  workProjectLabel,
  workProjectNames,
  workSearchPort,
} from '../../../../app/search/work-search.ts';
import { fakeClient, refusal } from '../../../support/app/client.tsx';

const RELAY_PROJECT = '6f1c2f0e-3a4b-4c55-9d1e-0a7b8c9d1e2f';

const EMPTY = { hits: [], total: 0, indexed: { cards: 3, asks: 2 } };

const hit = (match: WorkHit['match']): WorkHit => ({
  kind: 'card',
  id: 'F1',
  project: RELAY_PROJECT,
  ferret: null,
  title: 'Relay handshake',
  state: 'open',
  standing: 'Doing',
  updatedAt: '2026-10-30T10:00:00.000Z' as WorkHit['updatedAt'],
  match,
  score: 1,
});

describe('the work search client', () => {
  it('asks GET /v1/search with only the filters given, and parses the answer', async () => {
    const client = fakeClient({ 'GET /v1/search': () => EMPTY });
    const answer = await fetchWorkSearch(client, { q: ' relay ', kind: 'ask', open: true, limit: 5 });
    expect(client.calls.map(call => call.query)).toEqual([{ q: 'relay', kind: 'ask', open: 'true', limit: '5' }]);
    expect(answer.indexed).toEqual({ cards: 3, asks: 2 });
  });

  it('leaves out a filter that is not set', async () => {
    const client = fakeClient({ 'GET /v1/search': () => EMPTY });
    await fetchWorkSearch(client, { q: 'relay', open: false });
    await workSearchPort(client).search({ q: 'relay', all: true });
    expect(client.calls.map(call => call.query)).toEqual([{ q: 'relay' }, { q: 'relay', all: 'true' }]);
  });

  it("passes on the daemon's refusal, and rejects an answer that breaks the contract", async () => {
    const refused = fakeClient({
      'GET /v1/search': () => {
        throw refusal(404, 'not_found', 'nope');
      },
    });
    expect(fetchWorkSearch(refused, { q: 'relay' })).rejects.toBeInstanceOf(DaemonCallError);
    const malformed = fakeClient({ 'GET /v1/search': () => ({ hits: 'many' }) });
    expect(fetchWorkSearch(malformed, { q: 'relay' })).rejects.toThrow();
  });

  it('asks nothing for a search already abandoned, and drops an answer that lands after it was', async () => {
    const client = fakeClient({ 'GET /v1/search': () => EMPTY });
    const gone = new AbortController();
    gone.abort();
    expect(fetchWorkSearch(client, { q: 'relay' }, gone.signal)).rejects.toThrow('abandoned');
    expect(client.calls).toEqual([]);

    const late = new AbortController();
    client.on('GET /v1/search', () => {
      late.abort();
      return EMPTY;
    });
    expect(fetchWorkSearch(client, { q: 'relay' }, late.signal)).rejects.toThrow('abandoned');
  });
});

describe('what counts as words', () => {
  it('treats ids and single letters as the start of an id, and anything longer as words', () => {
    for (const idLike of ['', ' ', 'f', 'F3', 'a12', '12']) expect(isWorkSearchWords(idLike)).toBe(false);
    for (const words of ['relay', 'region choice', 'ab']) expect(isWorkSearchWords(words)).toBe(true);
  });
});

describe('the line a hit matched', () => {
  it('names the field for a body match and says nothing for a title or id match', () => {
    expect(workHitDescription(hit({ field: 'howToTest', line: ' open the page ' }))).toBe('how to test: open the page');
    expect(workHitDescription(hit({ field: 'progress', line: ' writing the route ' }))).toBe(
      'progress: writing the route',
    );
    expect(workHitDescription(hit({ field: 'title', line: 'Relay handshake' }))).toBe('');
    expect(workHitDescription(hit({ field: 'id', line: 'F1' }))).toBe('');
    expect(workHitDescription(hit({ field: 'note', line: '   ' }))).toBe('');
  });
});

describe('the key a hit is known by', () => {
  it('is the card id for a card, and the ferret with the id for an ask, whose id is per ferret', () => {
    const { match, score, title, state, standing, updatedAt } = hit({ field: 'title', line: '' });
    expect(workHitKey({ kind: 'ask', id: 'A3', ferret: 'f1', match, score, title, state, standing, updatedAt })).toBe(
      'ask:f1:A3',
    );
    expect(workHitKey(hit({ field: 'title', line: '' }))).toBe('card:F1');
  });
});

describe('the project a card lives in', () => {
  const names = workProjectNames([
    { id: RELAY_PROJECT, name: 'Relay' },
    { id: 'unfiled', name: 'Unfiled' },
  ]);

  it("is named by the board's project, never by its id", () => {
    expect(workProjectLabel(RELAY_PROJECT, names)).toBe('Relay');
  });

  it('says Unfiled for the unfiled board even before any names have loaded', () => {
    expect(workProjectLabel('unfiled', undefined)).toBe('Unfiled');
    expect(workProjectLabel('unfiled', new Map())).toBe('Unfiled');
  });

  it('says nothing for a project it has no name for', () => {
    const stranger = '11111111-2222-4333-8444-555555555555';
    expect(workProjectLabel(stranger, names)).toBe('');
    expect(workProjectLabel(RELAY_PROJECT, undefined)).toBe('');
  });
});
