import { describe, it } from 'bun:test';
import { type BoardTask, WorkSearchQuerySchema } from '@ferretry/protocol';
import should from 'should';
import { WORK_SEARCH_SWEEP_MS } from '../../../src/lib/work-search/index.ts';
import { card, FakeRedaction, FakeSources, item, ledger, NOW_MS, service } from './support.ts';

const q = (text: string, rest: Record<string, unknown> = {}) => WorkSearchQuerySchema.parse({ q: text, ...rest });

describe('the work search service', () => {
  it('should see a card the daemon just wrote, on the very next search', async () => {
    // Arrange
    const sources = new FakeSources([card({ id: 'F1', title: 'Board store' })]);
    const { search } = service(sources);
    should((await search.search(q('relay'))).hits).eql([]);

    // Act: the store replaces the card's object on a write
    sources.cardsById.set('F1', card({ id: 'F1', title: 'Relay carrier' }));
    const after = await search.search(q('relay'));

    // Assert
    should(after.hits.map(hit => hit.id)).eql(['F1']);
  });

  it('should re-index only the cards whose object changed', async () => {
    // Arrange
    const sources = new FakeSources([card({ id: 'F1', title: 'One' }), card({ id: 'F2', title: 'Two' })]);
    const redaction = new FakeRedaction();
    const { search } = service(sources, { redaction });
    await search.search(q('one'));
    const before = redaction.batches;

    // Act: nothing changed, so no batch is opened to index anything (only the answer's own scrub)
    await search.search(q('two'));

    // Assert
    should(redaction.batches - before).equal(1);
  });

  it('should see an agenda change the moment the agenda says it committed', async () => {
    // Arrange
    const sources = new FakeSources([], [ledger('lead', [item({ id: 'A1', subject: 'Pick a backend' })])]);
    const { search } = service(sources);
    await search.search(q('backend'));

    // Act
    sources.ledgers.set('lead', ledger('lead', [item({ id: 'A1', subject: 'Pick a relay' })]));
    await search.changed('lead');
    const after = await search.search(q('relay'));

    // Assert
    should(after.hits.map(hit => [hit.kind, hit.id])).eql([['agenda', 'A1']]);
  });

  it('should see an agenda ledger edited outside the daemon within one sweep', async () => {
    // Arrange
    let now = NOW_MS;
    const sources = new FakeSources([], [ledger('lead', [item({ id: 'A1', subject: 'Pick a backend' })])]);
    const { search } = service(sources, { now: () => now });
    await search.search(q('backend'));

    // Act: the file changes and nobody tells the service; time passes one sweep
    sources.ledgers.set('lead', ledger('lead', [item({ id: 'A1', subject: 'Pick a relay' })]));
    const tooSoon = await search.search(q('relay'));
    now += WORK_SEARCH_SWEEP_MS;
    await search.search(q('relay'));
    await search.settled();
    const after = await search.search(q('relay'));

    // Assert
    should(tooSoon.hits).eql([]);
    should(after.hits.map(hit => hit.id)).eql(['A1']);
  });

  it('should drop the items of a session whose ledger is gone', async () => {
    // Arrange
    let now = NOW_MS;
    const sources = new FakeSources([], [ledger('gone', [item({ id: 'A1', subject: 'Pick a backend' }, 'gone')])]);
    const { search } = service(sources, { now: () => now });
    await search.search(q('backend'));

    // Act
    sources.ledgers.delete('gone');
    now += WORK_SEARCH_SWEEP_MS;
    await search.search(q('backend'));
    await search.settled();

    // Assert
    should((await search.search(q('backend'))).hits).eql([]);
  });

  it('should rebuild with the new values as soon as the secrets change, so a masked value is never findable', async () => {
    // Arrange
    const sources = new FakeSources([card({ id: 'F1', title: 'Login', summary: 'the token is s3cr3tvalue' })]);
    const redaction = new FakeRedaction();
    const { search } = service(sources, { redaction });
    should((await search.search(q('s3cr3tvalue'))).hits.map(hit => hit.id)).eql(['F1']);

    // Act: the value becomes a secret (the vault file changed)
    redaction.values = ['s3cr3tvalue'];
    redaction.generation += 1;
    const after = await search.search(q('s3cr3tvalue'));
    const byOther = await search.search(q('token'));

    // Assert
    should(after.hits).eql([]);
    should(byOther.hits[0]?.match.line).equal('the token is [redacted]');
  });

  it('should scrub an answer once more as it leaves', async () => {
    // Arrange: a value known only after its card was indexed, with the epoch not yet moved
    const sources = new FakeSources([card({ id: 'F1', title: 'Deploy key abc123xyz' })]);
    const redaction = new FakeRedaction();
    const { search } = service(sources, { redaction });
    await search.search(q('deploy'));

    // Act
    redaction.values = ['abc123xyz'];
    const answer = await search.search(q('deploy'));

    // Assert
    should(answer.hits[0]?.title).equal('Deploy key [redacted]');
  });

  it('should keep what it indexed from a ledger it cannot read, and say so', async () => {
    // Arrange
    const sources = new FakeSources([], [ledger('lead', [item({ id: 'A1', subject: 'Pick a backend' })])]);
    const { search, warnings } = service(sources);
    await search.search(q('backend'));
    sources.ledger = async () => {
      throw new Error('invalid agenda ledger');
    };

    // Act
    await search.changed('lead');
    const after = await search.search(q('backend'));

    // Assert
    should(after.hits.map(hit => hit.id)).eql(['A1']);
    should(warnings.join('\n')).containEql('invalid agenda ledger');
  });

  it('should answer the related check with strong matches first', async () => {
    // Arrange
    const sources = new FakeSources([
      card({ id: 'F38', title: 'Agenda focus view' }),
      card({ id: 'F6', title: 'Pairing codes' }),
    ]);
    const { search } = service(sources);

    // Act
    const answer = await search.related({ kind: 'task', title: 'Agenda item focus view' });

    // Assert
    should(answer.matches.map(match => [match.strength, match.hit.id])).eql([['strong', 'F38']]);
  });
});

describe('the work search latency budget', () => {
  const WORDS = (
    'relay pairing board agenda snooze lane card search index cache daemon warden browser terminal secret login ' +
    'catalog member grant device phone inbox notify lesson skill runtime quota budget migrate worktree release'
  ).split(' ');
  const pick = (seed: number, count: number): string =>
    Array.from({ length: count }, (_, at) => WORDS[(seed * 7 + at * 13) % WORDS.length]).join(' ');

  it('should answer a mixed search under 30 ms at p95 over 2,000 cards and 500 agenda items', async () => {
    // Arrange
    const cards: BoardTask[] = Array.from({ length: 2_000 }, (_, at) =>
      card({
        id: `F${at + 1}`,
        title: pick(at, 3),
        summary: pick(at + 1, 8),
        ask: { text: pick(at + 2, 30), source: 'owner' },
        brief: pick(at + 3, 120),
        laneId: at % 5 === 0 ? 'closed' : 'todo',
      }),
    );
    const ledgers = Array.from({ length: 50 }, (_, session) =>
      ledger(
        `session-${session}`,
        Array.from({ length: 10 }, (_, at) =>
          item({ id: `A${at + 1}`, subject: pick(session + at, 4), why: pick(session * at, 40) }, `session-${session}`),
        ),
      ),
    );
    const sources = new FakeSources(cards, ledgers);
    const { search } = service(sources);
    await search.search(q('warm'));
    const queries = ['relay', 'agenda snoo', 'F1234', '!A3', 'board lane card', 'secret login device', 'quota bud'];

    // Act
    const elapsed: number[] = [];
    for (let round = 0; round < 30; round += 1)
      for (const text of queries) {
        const started = performance.now();
        await search.search(q(text, round % 2 === 0 ? {} : { open: true, kind: 'task' }));
        elapsed.push(performance.now() - started);
      }
    elapsed.sort((left, right) => left - right);
    const p95 = elapsed[Math.floor(elapsed.length * 0.95)] ?? Number.POSITIVE_INFINITY;

    // Assert
    should((await search.search(q('relay'))).indexed).eql({ tasks: 2_000, agenda: 500 });
    should(p95).be.below(30);
  });
});
