import { describe, expect, it } from 'bun:test';
import type { WorkHit } from '@ferretry/protocol';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { DaemonResponseError } from '../../src/lib/runtime-models.ts';
import {
  fetchWorkSearch,
  isWorkSearchWords,
  workHitDescription,
  workProjectLabel,
  workProjectNames,
  workSearchPortFor,
} from '../../src/lib/work-search.ts';

const RELAY_PROJECT = '6f1c2f0e-3a4b-4c55-9d1e-0a7b8c9d1e2f';

const daemon = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceId: 'token-a' });

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const hit = (match: WorkHit['match']): WorkHit => ({
  kind: 'task',
  id: 'F1',
  projectId: RELAY_PROJECT,
  sessionId: null,
  title: 'Relay handshake',
  state: 'open',
  standing: 'Doing',
  updatedAt: '2026-10-30T10:00:00.000Z',
  match,
  score: 1,
});

describe('the work search client', () => {
  it('asks GET /v1/search with only the filters given, and parses the answer', async () => {
    const urls: string[] = [];
    const answer = await fetchWorkSearch(daemon, { q: ' relay ', kind: 'agenda', open: true, limit: 5 }, async url => {
      urls.push(String(url));
      return json({ hits: [], total: 0, indexed: { tasks: 3, agenda: 2 } });
    });
    expect(urls).toEqual(['https://a.example.test/v1/search?q=relay&kind=agenda&open=true&limit=5']);
    expect(answer.indexed).toEqual({ tasks: 3, agenda: 2 });
  });

  it('leaves out a filter that is not set', async () => {
    const urls: string[] = [];
    await fetchWorkSearch(daemon, { q: 'relay' }, async url => {
      urls.push(String(url));
      return json({ hits: [], total: 0, indexed: { tasks: 0, agenda: 0 } });
    });
    expect(urls).toEqual(['https://a.example.test/v1/search?q=relay']);
  });

  it('throws the daemon status for a refusal, and rejects an answer that breaks the contract', async () => {
    const refused = fetchWorkSearch(daemon, { q: 'relay' }, async () => json({ error: 'nope' }, 404));
    expect(refused).rejects.toBeInstanceOf(DaemonResponseError);
    const malformed = fetchWorkSearch(daemon, { q: 'relay' }, async () => json({ hits: 'many' }));
    expect(malformed).rejects.toThrow();
  });
});

describe('which machines get a search port', () => {
  it('hands one out only for a machine whose health said it can search', () => {
    const fetcher = async () => json({});
    expect(workSearchPortFor(true, daemon, fetcher)).toBeDefined();
    expect(workSearchPortFor(false, daemon, fetcher)).toBeUndefined();
    expect(workSearchPortFor(undefined, daemon, fetcher)).toBeUndefined();
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
    expect(workHitDescription(hit({ field: 'title', line: 'Relay handshake' }))).toBe('');
    expect(workHitDescription(hit({ field: 'id', line: 'F1' }))).toBe('');
    expect(workHitDescription(hit({ field: 'note', line: '   ' }))).toBe('');
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
