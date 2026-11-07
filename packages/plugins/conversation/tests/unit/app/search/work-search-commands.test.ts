import { describe, expect, it } from 'bun:test';
import type { PluginCommandContext } from '@ferretry/app';
import type { WorkHit, WorkSearchResponse } from '../../../../contract/index.ts';
import {
  WORK_GROUPS,
  WORK_SEARCH_LIMIT,
  workHitEntry,
  workHitHref,
  workSearchCommandSource,
} from '../../../../app/search/work-search-commands.ts';
import type { WorkSearchPort, WorkSearchRequest } from '../../../../app/search/work-search.ts';
import { fakeClient, testHref } from '../../../support/app/client.tsx';

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
  const source = workSearchCommandSource(context, { port, schedule, debounceMs: 7 });
  /** Lets a resolved answer's `then` run. */
  const land = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };
  return { source, pending, timers, pause, navigated, context, land, changes: () => changes };
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
    expect(pending.map(each => each.request)).toEqual([{ q: 'relay', limit: WORK_SEARCH_LIMIT }]);
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
    expect(changes()).toBe(1);
    expect(source('relay handshake').map(entry => entry.id)).toEqual(['work-card:F10']);
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
