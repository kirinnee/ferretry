import { describe, it } from 'bun:test';
import { type WorkSearchQuery, WorkSearchQuerySchema } from '@ferretry/protocol';
import should from 'should';
import { cardDocument, ledgerDocuments, WorkIndex } from '../../../src/lib/work-search/index.ts';
import { addressed, at, card, DAY_MS, item, LANES, ledger, NOW_MS } from './support.ts';

const same = (text: string): string => text;
const query = (q: string, rest: Partial<WorkSearchQuery> = {}): WorkSearchQuery =>
  WorkSearchQuerySchema.parse({ q, ...rest });

const indexOf = (...documents: (ReturnType<typeof cardDocument> | readonly ReturnType<typeof cardDocument>[])[]) => {
  const index = new WorkIndex();
  for (const entry of documents.flat()) if (entry !== undefined) index.put(entry);
  return index;
};
const cardDoc = (overrides: Parameters<typeof card>[0]) => cardDocument(card(overrides), LANES, same, NOW_MS);
const ids = (index: WorkIndex, q: string, rest: Partial<WorkSearchQuery> = {}) =>
  index.search(query(q, rest), NOW_MS).hits.map(hit => hit.id);

describe('the work search index', () => {
  it('should find a card by words that are only in its summary, and say the summary matched', () => {
    // Arrange
    const index = indexOf(
      cardDoc({ id: 'F1', title: 'Board store', summary: 'one inverted index over every card' }),
      cardDoc({ id: 'F2', title: 'Lane sets' }),
    );

    // Act
    const result = index.search(query('inverted index'), NOW_MS);

    // Assert
    should(result.hits.map(hit => hit.id)).eql(['F1']);
    should(result.hits[0]?.match).eql({ field: 'summary', line: 'one inverted index over every card' });
    should(result.total).equal(1);
  });

  it('should find an agenda item by words in its body and in its history', () => {
    // Arrange
    const open = item({
      id: 'A3',
      why: 'the relay drops sessions after a deploy',
      history: [{ at: at(NOW_MS), kind: 'updated', note: 'checked the cloudflare logs' }],
    });
    const index = indexOf(ledgerDocuments(ledger('lead', [open]), same, NOW_MS));

    // Act
    const byBody = index.search(query('relay drops'), NOW_MS).hits;
    const byHistory = index.search(query('cloudflare'), NOW_MS).hits;

    // Assert
    should(byBody.map(hit => [hit.kind, hit.id, hit.sessionId, hit.match.field])).eql([
      ['agenda', 'A3', 'lead', 'body'],
    ]);
    should(byHistory.map(hit => hit.match.field)).eql(['history']);
  });

  it('should put an exact id first, in every spelling a person types', () => {
    // Arrange
    const index = indexOf(
      cardDoc({ id: 'F12', title: 'Board store' }),
      cardDoc({ id: 'F3', title: 'Mentions F12 in passing', summary: 'see F12' }),
    );

    // Act / Assert
    for (const spelling of ['F12', 'f12', '&F12', '#F12']) should(ids(index, spelling)[0]).equal('F12');
  });

  it('should rank a title match above the same words in a note', () => {
    // Arrange
    const index = indexOf(
      cardDoc({
        id: 'F1',
        title: 'Lane sets',
        history: [
          { seq: 1, at: at(NOW_MS), actor: { kind: 'owner' }, type: 'created', laneId: 'todo' },
          { seq: 2, at: at(NOW_MS), actor: { kind: 'owner' }, type: 'note', text: 'the relay carrier is unrelated' },
        ],
      }),
      cardDoc({ id: 'F2', title: 'Relay carrier' }),
    );

    // Act / Assert
    should(ids(index, 'relay carrier')).eql(['F2', 'F1']);
  });

  it('should match the last word as a prefix, so a half-typed word already finds', () => {
    // Arrange
    const index = indexOf(cardDoc({ id: 'F1', title: 'Snooze agenda items' }));

    // Act / Assert
    should(ids(index, 'agenda snoo')).eql(['F1']);
    should(ids(index, 'snoo agenda')).eql([]);
  });

  it('should need every word, and narrow by kind and by open', () => {
    // Arrange
    const index = indexOf(
      cardDoc({ id: 'F1', title: 'Search cards' }),
      cardDoc({ id: 'F2', title: 'Search agenda', laneId: 'closed' }),
      ledgerDocuments(ledger('lead', [item({ id: 'A1', subject: 'Search everything' })]), same, NOW_MS),
    );

    // Act / Assert
    should(ids(index, 'search cards')).eql(['F1']);
    should(ids(index, 'search', { kind: 'agenda' })).eql(['A1']);
    should(ids(index, 'search', { kind: 'task', open: true })).eql(['F1']);
    should(index.search(query('search agenda'), NOW_MS).hits[0]).match({ state: 'closed', standing: 'Closed' });
  });

  it('should lift open and recent work over the same match on old closed work', () => {
    // Arrange
    const old = NOW_MS - 20 * DAY_MS;
    const index = indexOf(
      cardDoc({
        id: 'F1',
        title: 'Relay',
        laneId: 'closed',
        history: [{ seq: 1, at: at(old), actor: { kind: 'owner' }, type: 'created', laneId: 'closed' }],
      }),
      cardDoc({ id: 'F2', title: 'Relay' }),
    );

    // Act / Assert
    should(ids(index, 'relay')).eql(['F2', 'F1']);
  });

  it('should leave out work closed longer ago than the window, and keep old open work', () => {
    // Arrange
    const long = NOW_MS - 45 * DAY_MS;
    const created = [
      { seq: 1, at: at(long), actor: { kind: 'owner' as const }, type: 'created' as const, laneId: 'closed' },
    ];

    // Act
    const closed = cardDocument(card({ id: 'F1', laneId: 'closed', history: created }), LANES, same, NOW_MS);
    const open = cardDocument(card({ id: 'F2', laneId: 'todo', history: created }), LANES, same, NOW_MS);
    const resolved = ledgerDocuments(
      ledger('lead', [], [addressed(item({ id: 'A1' }), { resolvedAt: at(long) })]),
      same,
      NOW_MS,
    );

    // Assert
    should(closed).be.undefined();
    should(open?.identity.state).equal('open');
    should(resolved).eql([]);
  });

  it('should index only the text a card shows, scrubbed, and never a plain notification', () => {
    // Arrange
    const scrub = (text: string) => text.split('hunter2').join('[redacted:PW]');
    const document = cardDocument(
      card({ id: 'F1', title: 'Login', summary: 'the password is hunter2', terms: [] }),
      LANES,
      scrub,
      NOW_MS,
    );
    const notices = ledgerDocuments(ledger('lead', [item({ id: 'A1', notice: true })]), same, NOW_MS);

    // Act
    const index = indexOf(document);

    // Assert
    should(JSON.stringify(document)).not.containEql('hunter2');
    should(ids(index, 'hunter2')).eql([]);
    should(notices).eql([]);
    should(document?.fields.map(field => field.field)).eql(['id', 'title', 'summary', 'ask']);
  });

  it('should forget a document taken out, words and id alike', () => {
    // Arrange
    const index = indexOf(cardDoc({ id: 'F1', title: 'Relay carrier' }));

    // Act
    index.remove('task:F1');

    // Assert
    should(ids(index, 'relay')).eql([]);
    should(ids(index, 'F1')).eql([]);
    should(index.size).eql({ tasks: 0, agenda: 0 });
  });
});

describe('the related check', () => {
  const board = () =>
    indexOf(
      cardDoc({
        id: 'F38',
        title: 'Agenda focus view',
        ask: { text: 'one item at a time, full screen', source: 'owner' },
      }),
      cardDoc({ id: 'F31', title: 'Board phone layout', ask: { text: 'the board on a phone', source: 'owner' } }),
      cardDoc({ id: 'F5', title: 'Relay carrier', laneId: 'closed' }),
      cardDoc({ id: 'F6', title: 'Pairing codes' }),
    );

  it('should call a near-identical open title strong', () => {
    // Act
    const matches = board().related('Agenda item focus view', 'show one agenda item full screen', NOW_MS, 5);

    // Assert
    should(matches[0]).match({ strength: 'strong', hit: { id: 'F38' } });
  });

  it('should not call a long ask that merely mentions a short title strong', () => {
    // Act
    const matches = board().related(
      'Inbox swipe gestures',
      'on the phone the inbox should swipe; the board layout already does something similar',
      NOW_MS,
      5,
    );

    // Assert
    should(matches.filter(match => match.strength === 'strong')).eql([]);
  });

  it('should call closed work at most weak', () => {
    // Act
    const matches = board().related('Relay carrier', '', NOW_MS, 5);

    // Assert
    should(matches.map(match => [match.hit.id, match.strength])).eql([['F5', 'weak']]);
  });

  it('should find nothing for unrelated work', () => {
    // Act / Assert
    should(board().related('Speech to text cleanup', 'dictation punctuation', NOW_MS, 5)).eql([]);
  });
});
