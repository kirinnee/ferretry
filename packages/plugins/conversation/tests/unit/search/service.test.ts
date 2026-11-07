import { describe, expect, test } from 'bun:test';
import { WorkSearchService, WORK_SEARCH_SWEEP_MS } from '../../../daemon/search/lib/service.ts';
import { askWork, cardWork, FakeRedaction, FakeSource, NOW_MS, query } from '../../support/work.ts';

const build = (sources: readonly FakeSource[], options: { redaction?: FakeRedaction; clock?: { ms: number } } = {}) => {
  const warnings: string[] = [];
  const clock = options.clock ?? { ms: NOW_MS };
  const service = new WorkSearchService({
    sources,
    redaction: options.redaction ?? new FakeRedaction(),
    now: () => clock.ms,
    warn: message => warnings.push(message),
  });
  return { service, warnings, clock };
};

describe('the work search service', () => {
  test('the first search builds from every source and answers with what it indexed', async () => {
    const cards = new FakeSource('cards', [cardWork({ id: 'F1', title: 'Relay carrier' })], true);
    const asks = new FakeSource('asks', [askWork({ id: 'A1', title: 'Relay question' })]);
    const { service } = build([cards, asks]);
    const answer = await service.search(query('relay'));
    expect(answer.hits.map(hit => hit.id).sort()).toEqual(['A1', 'F1']);
    expect(answer.indexed).toEqual({ cards: 1, asks: 1 });
  });

  test('a cheap source is read on every search, another only when it says it changed', async () => {
    const cards = new FakeSource('cards', [cardWork({ id: 'F1', title: 'Relay carrier' })], true);
    const asks = new FakeSource('asks', [askWork({ id: 'A1', title: 'Relay question' })]);
    const { service } = build([cards, asks]);
    await service.search(query('relay'));
    cards.works.set('card:F2', cardWork({ id: 'F2', title: 'Relay pairing' }));
    asks.works.set('ask:A2', askWork({ id: 'A2', title: 'Relay second' }));
    const seen = (await service.search(query('relay'))).hits.map(hit => hit.id);
    expect(seen).toContain('F2');
    expect(seen).not.toContain('A2');
    await service.changed('asks');
    expect((await service.search(query('relay'))).hits.map(hit => hit.id)).toContain('A2');
  });

  test('a sweep finds a change nobody announced', async () => {
    const asks = new FakeSource('asks', [askWork({ id: 'A1', title: 'Relay question' })]);
    const { service, clock } = build([asks]);
    await service.search(query('relay'));
    asks.works.set('ask:A2', askWork({ id: 'A2', title: 'Relay second' }));
    clock.ms += WORK_SEARCH_SWEEP_MS + 1;
    await service.search(query('relay'));
    await service.settled();
    expect((await service.search(query('relay'))).hits.map(hit => hit.id)).toContain('A2');
  });

  test('a piece of work that went away leaves the index', async () => {
    const cards = new FakeSource('cards', [cardWork({ id: 'F1', title: 'Relay carrier' })], true);
    const { service } = build([cards]);
    expect((await service.search(query('relay'))).total).toBe(1);
    cards.works.clear();
    expect((await service.search(query('relay'))).total).toBe(0);
  });

  test('a secret is never indexed, and a changed epoch rebuilds before the next answer', async () => {
    const redaction = new FakeRedaction();
    redaction.values = ['hunter2'];
    const cards = new FakeSource('cards', [
      cardWork({ id: 'F1', title: 'Login', fields: { summary: 'the password is hunter2' } }),
    ]);
    const { service } = build([cards], { redaction });
    expect((await service.search(query('hunter2'))).total).toBe(0);
    redaction.values = ['password'];
    redaction.generation += 1;
    const answer = await service.search(query('hunter2'));
    expect(answer.total).toBe(1);
    expect(answer.hits[0]?.match.line).toBe('the [redacted] is hunter2');
  });

  test('an unreadable source keeps what it gave and is named once in a warning', async () => {
    const asks = new FakeSource('asks', [askWork({ id: 'A1', title: 'Relay question' })]);
    const { service, warnings } = build([asks]);
    await service.search(query('relay'));
    asks.failing = true;
    await service.changed('asks');
    expect((await service.search(query('relay'))).total).toBe(1);
    expect(warnings.some(line => line.includes('asks'))).toBe(true);
  });

  test('the related check answers with strength and masks what it quotes', async () => {
    const cards = new FakeSource('cards', [cardWork({ id: 'F1', title: 'Agenda focus view' })], true);
    const { service } = build([cards]);
    const answer = await service.related({ kind: 'card', title: 'Agenda focus view' });
    expect(answer.matches[0]?.strength).toBe('strong');
    expect(answer.matches[0]?.hit.id).toBe('F1');
  });
});

describe('a value that became a secret after it was indexed (no epoch moved)', () => {
  const secretCard = () =>
    new FakeSource('cards', [cardWork({ id: 'F1', title: 'Login', fields: { summary: 'the password is hunter2' } })]);

  test('is no longer found, counted or quoted by a search', async () => {
    const redaction = new FakeRedaction();
    const { service } = build([secretCard()], { redaction });
    expect((await service.search(query('hunter2'))).total).toBe(1);
    redaction.values = ['hunter2'];
    const answer = await service.search(query('hunter2', { all: true }));
    expect(answer).toMatchObject({ hits: [], total: 0, olderHidden: 0 });
    const other = await service.search(query('password'));
    expect(other.total).toBe(1);
    expect(other.hits[0]?.match.line).toBe('the password is [redacted]');
  });

  test('is no longer what a related check matches on', async () => {
    const redaction = new FakeRedaction();
    const cards = new FakeSource('cards', [cardWork({ id: 'F1', title: 'Quokka zebra' })], true);
    const { service } = build([cards], { redaction });
    expect((await service.related({ kind: 'card', title: 'Quokka zebra' })).matches).toHaveLength(1);
    redaction.values = ['Quokka zebra'];
    expect((await service.related({ kind: 'card', title: 'Quokka zebra' })).matches).toEqual([]);
  });

  test('a redaction that cannot open refuses the answer instead of answering from older text', async () => {
    const redaction = new FakeRedaction();
    const { service } = build([secretCard()], { redaction });
    await service.search(query('hunter2'));
    redaction.batch = async () => {
      throw new Error('the vault will not open');
    };
    await expect(service.search(query('hunter2'))).rejects.toThrow('the vault will not open');
    await expect(service.related({ kind: 'card', title: 'Login' })).rejects.toThrow('the vault will not open');
  });
});

describe('G164 work search cannot tell whether a value that became a secret appears (review round 2 probes)', () => {
  const HIDDEN = 'zqsecret';
  const GUESS = 'zqguess';
  const board = () =>
    new FakeSource(
      'cards',
      [
        cardWork({ id: 'F1', title: 'Quokka widget' }),
        cardWork({ id: 'F2', title: `Plinth ${HIDDEN}` }),
        cardWork({ id: 'F3', title: `Marble ${HIDDEN}` }),
        cardWork({ id: 'F4', title: 'Unrelated thing' }),
      ],
      true,
    );
  /** Indexed while the value was ordinary text, then registered as a secret with no epoch change. */
  const afterIndexing = async () => {
    const redaction = new FakeRedaction();
    const { service } = build([board()], { redaction });
    await service.search(query('quokka'));
    redaction.values = [HIDDEN];
    return { service, redaction };
  };
  const relatedOf = async (service: WorkSearchService, title: string) =>
    (await service.related({ kind: 'card', title })).matches.map(match => [
      match.hit.id,
      match.strength,
      match.hit.score,
    ]);

  test('G164 a search for it finds, counts and quotes nothing, exactly like a word nobody wrote', async () => {
    const { service } = await afterIndexing();
    const secret = await service.search(query(HIDDEN, { all: true }));
    const guess = await service.search(query(GUESS, { all: true }));
    expect(secret).toEqual(guess);
    expect(secret).toMatchObject({ hits: [], total: 0, olderHidden: 0 });
    const prefix = await service.search(query('zqs', { all: true }));
    expect(prefix).toMatchObject({ hits: [], total: 0 });
  });

  test('G164 a related check weighs it like a word no item holds: the same scores, strengths and order', async () => {
    const { service, redaction } = await afterIndexing();
    const secret = await relatedOf(service, `Quokka widget ${HIDDEN}`);
    const guess = await relatedOf(service, `Quokka widget ${GUESS}`);
    expect(secret).toEqual(guess);
    redaction.generation += 1;
    expect(await relatedOf(service, `Quokka widget ${HIDDEN}`)).toEqual(secret);
  });

  test('G164 a related check cannot reach an item through the mask the secret left behind', async () => {
    const { service } = await afterIndexing();
    expect(await relatedOf(service, `Plinth redacted ${HIDDEN}`)).toEqual(
      await relatedOf(service, `Plinth redacted ${GUESS}`),
    );
    expect(await relatedOf(service, `Pebble redacted ${HIDDEN}`)).toEqual(
      await relatedOf(service, `Pebble redacted ${GUESS}`),
    );
  });

  test('G164 a redaction that fails refuses every search and related check alike, matched or not', async () => {
    const { service, redaction } = await afterIndexing();
    redaction.batch = async () => {
      throw new Error('vault closed');
    };
    for (const q of [HIDDEN, GUESS, 'quokka'])
      await expect(service.search(query(q, { all: true }))).rejects.toThrow('vault closed');
    for (const title of [`Quokka ${HIDDEN}`, `Quokka ${GUESS}`, GUESS])
      await expect(service.related({ kind: 'card', title })).rejects.toThrow('vault closed');
  });
});
