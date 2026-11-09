import { describe, expect, it } from 'bun:test';
import type { PluginCommandContext } from '@ferretry/app';
import type { WorkHit, WorkSearchResponse } from '../../../../contract/index.ts';
import {
  MAX_WORK_ROWS_PER_KIND,
  WORK_GROUPS,
  WORK_SEARCH_LIMIT,
  workHitEntry,
  workHitHref,
  workSearchCommandSource,
} from '../../../../app/search/work-search-commands.ts';
import type { WorkSearchPort, WorkSearchRequest } from '../../../../app/search/work-search.ts';
import { fakeClient } from '../../../support/app/fake-client.ts';
import { testHref } from '../../../support/app/client.tsx';

/**
 * Today's palette asked the daemon's work search itself; in 5.0 Conversation hands the shell's command bar a source
 * (lead decision Q10). These cases hold today's rules on that source: words only, one request per pause, the newest
 * request wins, the last answer stays while the next loads, and each hit opens where its plugin draws it.
 */

const RELAY_PROJECT = '6f1c2f0e-3a4b-4c55-9d1e-0a7b8c9d1e2f';
const AT = '2026-10-30T10:00:00.000Z' as WorkHit['updatedAt'];

const card = (id: string, patch: Partial<Extract<WorkHit, { kind: 'card' }>> = {}): WorkHit => ({
  kind: 'card',
  id,
  project: RELAY_PROJECT,
  ferret: 'f1',
  title: `Card ${id}`,
  state: 'open',
  standing: 'Doing',
  updatedAt: AT,
  match: { field: 'brief', line: 'the relay handshake drops' },
  score: 3,
  ...patch,
});

const ask = (id: string, patch: Partial<Extract<WorkHit, { kind: 'ask' }>> = {}): WorkHit => ({
  kind: 'ask',
  id,
  ferret: 'f1',
  title: `Ask ${id}`,
  state: 'open',
  standing: 'open',
  updatedAt: AT,
  match: { field: 'body', line: 'which relay should we pick' },
  score: 2,
  ...patch,
});

const answer = (...hits: WorkHit[]): WorkSearchResponse => ({
  hits,
  total: hits.length,
  indexed: { cards: hits.length, asks: hits.length },
});

const RESTING = { kind: 'all', state: 'everything' } as const;

interface Pending {
  readonly request: WorkSearchRequest;
  readonly signal: AbortSignal | undefined;
  readonly resolve: (response: WorkSearchResponse) => void;
  readonly reject: (error: Error) => void;
}

/** A source over a port whose answers a case hands out, and a clock a case turns by hand. */
const harness = (screenHref: PluginCommandContext['screenHref'] = testHref) => {
  const pending: Pending[] = [];
  const port: WorkSearchPort = {
    search: (request, signal) =>
      new Promise<WorkSearchResponse>((resolve, reject) => {
        pending.push({ request, signal, resolve, reject });
      }),
  };
  const timers: { run: () => void; delayMs: number; cancelled: boolean }[] = [];
  const schedule = (run: () => void, delayMs: number) => {
    const timer = { run, delayMs, cancelled: false };
    timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };
  /** The pause in typing elapses: every timer still set fires. */
  const pause = () => {
    for (const timer of timers.splice(0)) if (!timer.cancelled) timer.run();
  };
  const navigated: string[] = [];
  let changes = 0;
  const context: PluginCommandContext = {
    client: fakeClient(),
    daemon: 'alpha',
    navigate: href => navigated.push(href),
    screenHref,
    changed: () => {
      changes += 1;
    },
  };
  const built = workSearchCommandSource(context, { port, schedule, debounceMs: 7 });
  /** The entries the source lists for the words, with the chips at `filters` (resting: everything). */
  const source = (query: string, filters: Readonly<Record<string, string>> = RESTING) => {
    return built.list(query, filters).entries;
  };
  /** The whole answer, the pending line included. */
  const answered = (query: string, filters: Readonly<Record<string, string>> = RESTING) => built.list(query, filters);
  /** Lets a resolved answer's `then` run. */
  const land = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };
  return { source, answered, built, pending, timers, pause, navigated, context, land, changes: () => changes };
};

describe('the work search command source', () => {
  it('asks nothing for fewer than two characters, and nothing until typing pauses', () => {
    const { source, pending, timers, pause } = harness();
    expect(source('')).toEqual([]);
    expect(source(' r ')).toEqual([]);
    expect(timers).toEqual([]);

    expect(source('relay')).toEqual([]);
    expect(timers.map(timer => timer.delayMs)).toEqual([7]);
    expect(pending).toEqual([]);
    pause();
    expect(pending.map(each => each.request)).toEqual([
      { q: 'relay', all: true, open: false, limit: WORK_SEARCH_LIMIT },
    ]);
  });

  it('asks once per pause in typing, for the words last typed, and not again for the same words', () => {
    const { source, pending, pause } = harness();
    source('re');
    source('rel');
    source('relay ');
    source(' relay');
    pause();
    expect(pending.map(each => each.request.q)).toEqual(['relay']);
  });

  it('lists the cards and asks found, under their own headings, written the reference way, and says when it has them', async () => {
    const { source, pending, pause, land, changes } = harness();
    source('relay');
    pause();
    pending[0]?.resolve(
      answer(card('F10', { title: 'Harden the relay' }), ask('A3', { title: 'Pick a relay region' })),
    );
    await land();
    expect(changes()).toBe(1);

    const entries = source('relay');
    expect(entries.map(entry => [entry.group, entry.label, entry.description])).toEqual([
      [WORK_GROUPS.card, '&F10 Harden the relay', 'Doing · brief: the relay handshake drops'],
      [WORK_GROUPS.ask, '!A3 Pick a relay region', 'open · text: which relay should we pick'],
    ]);
    expect(entries.map(entry => entry.id)).toEqual(['work-card:F10', 'work-ask:f1:A3']);
  });

  it('keeps the words it answered among the keywords, so a hit found in the body text is not ranked away', async () => {
    const { source, pending, pause, land } = harness();
    source('handshake');
    pause();
    pending[0]?.resolve(answer(card('F10', { title: 'Harden the relay' })));
    await land();
    expect(source('handshake')[0]?.keywords).toEqual(['handshake', 'F10']);
  });

  it('keeps the last answer on screen while the next one loads', async () => {
    const { source, pending, pause, land } = harness();
    source('relay');
    pause();
    pending[0]?.resolve(answer(card('F10')));
    await land();

    expect(source('relay handshake').map(entry => entry.id)).toEqual(['work-card:F10']);
    pause();
    pending[1]?.resolve(answer(card('F11')));
    await land();
    expect(source('relay handshake').map(entry => entry.id)).toEqual(['work-card:F11']);
  });

  it('abandons the request in flight when the words change, and never lets its late answer land', async () => {
    const { source, pending, pause, land, changes } = harness();
    source('relay');
    pause();
    source('relay handshake');
    expect(pending[0]?.signal?.aborted).toBe(true);

    pending[0]?.resolve(answer(card('F9')));
    await land();
    expect(changes()).toBe(0);
    expect(source('relay handshake')).toEqual([]);
  });

  it('cancels a search not yet asked when the words fall below two characters', () => {
    const { source, timers, pause, pending } = harness();
    source('relay');
    expect(source('r')).toEqual([]);
    expect(timers.every(timer => timer.cancelled)).toBe(true);
    pause();
    expect(pending).toEqual([]);
  });

  it('keeps the last good answer when a later search fails', async () => {
    const { source, pending, pause, land, changes } = harness();
    source('relay');
    pause();
    pending[0]?.resolve(answer(card('F10')));
    await land();
    source('relay handshake');
    pause();
    pending[1]?.reject(new Error('offline'));
    await land();
    // the failure also asks the bar to list again, so the "Searching…" line goes
    expect(changes()).toBe(2);
    expect(source('relay handshake').map(entry => entry.id)).toEqual(['work-card:F10']);
  });

  it("asks for everything, so a closed card or ask older than the daemon's 30-day window is still found", () => {
    const { source, pending, pause } = harness();
    source('relay');
    pause();
    expect(pending[0]?.request.all).toBe(true);
  });

  it('lists at most six of each kind, as the palette did while both kinds were listed', async () => {
    const { source, pending, pause, land } = harness();
    source('relay');
    pause();
    const cards = Array.from({ length: 9 }, (_, index) => card(`F${index + 1}`));
    const asks = Array.from({ length: 8 }, (_, index) => ask(`A${index + 1}`));
    pending[0]?.resolve(answer(...cards, ...asks));
    await land();
    const entries = source('relay');
    expect(MAX_WORK_ROWS_PER_KIND).toBe(6);
    expect(entries.filter(entry => entry.group === WORK_GROUPS.card)).toHaveLength(6);
    expect(entries.filter(entry => entry.group === WORK_GROUPS.ask)).toHaveLength(6);
    expect(entries.map(entry => entry.id).slice(0, 2)).toEqual(['work-card:F1', 'work-card:F2']);
  });

  it("names a card's project under it, says Unfiled for the unfiled board, and never shows an id", async () => {
    const { source, pending, pause, land } = harness();
    source('relay');
    pause();
    pending[0]?.resolve(answer(card('F11', { project: 'unfiled' }), card('F12', { title: 'Orphan relay card' })));
    await land();
    const [unfiled, orphan] = source('relay');
    // The project is the row's second line (S11), not part of its description.
    expect(unfiled?.description).toBe('Doing · brief: the relay handshake drops');
    expect(unfiled?.detail).toBe('Unfiled');
    expect(orphan?.description).toBe('Doing · brief: the relay handshake drops');
    expect(orphan?.detail).toBeUndefined();
    for (const entry of [unfiled, orphan]) {
      expect(entry?.description).not.toContain(RELAY_PROJECT);
      expect(entry?.detail ?? '').not.toContain(RELAY_PROJECT);
      expect(entry?.detail ?? '').not.toContain('unfiled');
    }
  });

  it('opens a card on the board and an ask in the Agenda, on the same daemon', async () => {
    const { source, pending, pause, land, navigated } = harness();
    source('relay');
    pause();
    pending[0]?.resolve(answer(card('F10'), ask('A3')));
    await land();
    for (const entry of source('relay')) entry.run();
    expect(navigated).toEqual(['/alpha/board/card?id=F10', '/alpha/agenda/agenda-ask?ferret=f1&ask=A3']);
  });
});

describe('where a hit opens', () => {
  const context = { daemon: 'alpha', screenHref: testHref, navigate: () => undefined };

  it("asks the shell for the card's screen and the ask's, never a hard-coded address", () => {
    expect(workHitHref(card('F10'), context)).toBe('/alpha/board/card?id=F10');
    expect(workHitHref(ask('A3', { ferret: 'f2' }), context)).toBe('/alpha/agenda/agenda-ask?ferret=f2&ask=A3');
  });

  it('lists no entry for a hit no plugin on this machine draws', async () => {
    const asked: string[] = [];
    const screenHref: PluginCommandContext['screenHref'] = (daemon, plugin, screen, params) => {
      asked.push(plugin);
      return plugin === 'board' ? testHref(daemon, plugin, screen, params) : undefined;
    };
    expect(workHitEntry(ask('A3'), 'relay', { ...context, screenHref })).toBeUndefined();

    const { source, pending, pause, land } = harness(screenHref);
    source('relay');
    pause();
    pending[0]?.resolve(answer(card('F10'), ask('A3')));
    await land();
    expect(source('relay').map(entry => entry.id)).toEqual(['work-card:F10']);
    expect(asked).toContain('agenda');
  });

  it('says only its standing when the hit matched by title', () => {
    const entry = workHitEntry(card('F10', { match: { field: 'title', line: 'Card F10' } }), 'card', context);
    expect(entry?.description).toBe('Doing');
  });
});

describe('S11 the work search chips, pending line and muted rows', () => {
  it('S11 offers the Cards/Agenda and Everything/Open chips, everything first', () => {
    const { built } = harness();
    expect(built.filters?.map(filter => [filter.id, filter.options.map(option => option.label)])).toEqual([
      ['kind', ['All', 'Cards', 'Agenda']],
      ['state', ['Everything', 'Open']],
    ]);
  });

  it('S11 chips change what the daemon is asked: a kind, and open work only without the 30-day lift', () => {
    const { source, pending, pause } = harness();
    source('relay');
    pause();
    source('relay', { kind: 'card', state: 'everything' });
    pause();
    source('relay', { kind: 'ask', state: 'open' });
    pause();
    expect(pending.map(each => each.request)).toEqual([
      { q: 'relay', open: false, all: true, limit: WORK_SEARCH_LIMIT },
      { q: 'relay', kind: 'card', open: false, all: true, limit: WORK_SEARCH_LIMIT },
      { q: 'relay', kind: 'ask', open: true, all: false, limit: WORK_SEARCH_LIMIT },
    ]);
    expect(pending[0]?.signal?.aborted).toBe(true);
    expect(pending[1]?.signal?.aborted).toBe(true);
  });

  it('S11 says "Searching cards and agenda…" until the answer for these words and chips lands, then not', async () => {
    const { answered, pending, pause, land } = harness();
    expect(answered('relay')).toEqual({ entries: [], pending: 'Searching cards and agenda…' });
    pause();
    pending[0]?.resolve(answer(card('F10')));
    await land();
    expect('pending' in (answered('relay') as object)).toBe(false);
    // a chip is a new question: the rows stay, the line is back
    const again = answered('relay', { kind: 'card', state: 'everything' }) as { entries: unknown[]; pending?: string };
    expect(again.pending).toBe('Searching cards and agenda…');
    expect(again.entries).toHaveLength(1);
    // nothing asked below two characters: no line
    expect(answered('r')).toEqual({ entries: [] });
  });

  it('S11 a search that fails is no longer "searching": the line goes and the last rows stay', async () => {
    const { answered, pending, pause, land } = harness();
    answered('relay');
    pause();
    pending[0]?.reject(new Error('offline'));
    await land();
    expect(answered('relay')).toEqual({ entries: [] });
  });

  it('S11 closed and dropped work is muted, not hidden; open work is not', async () => {
    const { source, pending, pause, land } = harness();
    source('relay');
    pause();
    pending[0]?.resolve(
      answer(card('F1'), card('F2', { state: 'closed' }), ask('A1', { state: 'dropped' }), ask('A2')),
    );
    await land();
    expect(source('relay').map(entry => [entry.id, entry.muted === true])).toEqual([
      ['work-card:F1', false],
      ['work-card:F2', true],
      ['work-ask:f1:A1', true],
      ['work-ask:f1:A2', false],
    ]);
  });

  it('S11 one kind alone shows everything the daemon returned; both kinds together are capped at six each', async () => {
    const { source, pending, pause, land } = harness();
    const cards = Array.from({ length: 9 }, (_, index) => card(`F${index + 1}`));
    source('relay', { kind: 'card', state: 'everything' });
    pause();
    pending[0]?.resolve(answer(...cards));
    await land();
    expect(source('relay', { kind: 'card', state: 'everything' })).toHaveLength(9);
    expect(source('relay', RESTING)).toHaveLength(6);
  });
});
