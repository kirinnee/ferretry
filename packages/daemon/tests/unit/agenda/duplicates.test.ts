import { describe, it } from 'bun:test';
import { type AgendaGate, type AgendaItem, gateReference } from '@ferretry/protocol';
import should from 'should';
import {
  duplicateNote,
  type DuplicateAgenda,
  type DuplicateFacts,
  findDuplicates,
} from '../../../src/lib/agenda/duplicates.ts';

const gate = (cardId: string): AgendaGate => ({
  cardId,
  laneId: 'tested',
  laneName: 'Try it',
  entry: 1,
  projectId: 'p1',
  options: [{ id: 'o0', label: 'Done', outcome: 'close' }],
});

const item = (id: string, extra: Record<string, unknown> = {}): AgendaItem =>
  ({
    id,
    source: 'agent-raised',
    sourceRef: null,
    subject: `Ask ${id}`,
    waitingSince: '2026-10-01T10:00:00.000Z',
    raisedBy: 'agent',
    ...extra,
  }) as AgendaItem;

const agenda = (sessionId: string, items: AgendaItem[], home = sessionId): DuplicateAgenda => ({
  sessionId,
  home,
  items,
});

const facts = (answered: string[] = []): DuplicateFacts => ({ answeredGates: new Set(answered), gateReference });

describe('findDuplicates: one card with more than one open owner item', () => {
  it('keeps the thread on the owner turn, closes the gate item, and says what it kept', () => {
    const found = findDuplicates(
      [
        agenda('s1', [
          item('A1', { task: { id: 'F1' }, gate: gate('F1'), raisedBy: 'daemon', waitingOn: 'ferret' }),
          item('A2', { task: { id: 'F1' }, waitingSince: '2026-10-01T09:00:00.000Z' }),
        ]),
      ],
      facts(),
    );
    should(found.closures).deepEqual([
      { sessionId: 's1', id: 'A1', kind: 'card', keep: { sessionId: 's1', id: 'A2' } },
    ]);
    should(found.possible).deepEqual([]);
    should(duplicateNote({ sessionId: 's1', id: 'A2' })).equal('duplicate of !A2');
  });

  it('keeps the oldest ask, whichever agenda of the lineage it is on, and closes the rest', () => {
    const waiting = { waitingOn: 'ferret', task: { id: 'F1' } };
    const found = findDuplicates(
      [
        agenda('a', [item('A1', { ...waiting, waitingSince: '2026-10-01T09:00:00.000Z' })], 'x'),
        agenda('b', [item('A2', { ...waiting, waitingSince: '2026-10-01T11:00:00.000Z' })], 'x'),
        agenda('c', [item('A2', { ...waiting, waitingSince: '2026-10-01T11:00:00.000Z' })], 'x'),
      ],
      facts(),
    );
    should(found.closures.map(each => each.sessionId).sort()).deepEqual(['b', 'c']);
    should(found.closures.every(each => each.keep.sessionId === 'a')).equal(true);
  });

  it('keeps a newer ask that is on the owner turn over an older one that is not', () => {
    const found = findDuplicates(
      [
        agenda('s', [
          item('A1', { task: { id: 'F1' }, waitingOn: 'ferret', waitingSince: '2026-10-01T09:00:00.000Z' }),
          item('A2', { task: { id: 'F1' }, waitingSince: '2026-10-01T11:00:00.000Z' }),
        ]),
      ],
      facts(),
    );
    should(found.closures).deepEqual([{ sessionId: 's', id: 'A1', kind: 'card', keep: { sessionId: 's', id: 'A2' } }]);
  });

  it('breaks a tie on the id, lower first', () => {
    const waiting = { waitingOn: 'ferret', task: { id: 'F1' } };
    const found = findDuplicates([agenda('s', [item('A10', waiting), item('A3', waiting)], 'x')], facts());
    should(found.closures).deepEqual([{ sessionId: 's', id: 'A10', kind: 'card', keep: { sessionId: 's', id: 'A3' } }]);
  });

  it('breaks a tie on the session when the time and the id are the same', () => {
    const waiting = { waitingOn: 'ferret', task: { id: 'F1' } };
    const found = findDuplicates(
      [agenda('b', [item('A1', waiting)], 'x'), agenda('a', [item('A1', waiting)], 'x')],
      facts(),
    );
    should(found.closures).deepEqual([{ sessionId: 'b', id: 'A1', kind: 'card', keep: { sessionId: 'a', id: 'A1' } }]);
  });

  it('never groups one card across two lineages', () => {
    const found = findDuplicates(
      [agenda('a', [item('A1', { task: { id: 'F1' } })], 'x'), agenda('b', [item('A1', { task: { id: 'F1' } })], 'y')],
      facts(),
    );
    should(found).deepEqual({ closures: [], possible: [] });
  });

  it('reports, and closes nothing, when the asks were raised by different sessions', () => {
    const found = findDuplicates(
      [
        agenda('s', [
          item('A1', { task: { id: 'F1' }, raisedBySession: 'one' }),
          item('A2', { task: { id: 'F1' }, raisedBySession: 'two', waitingSince: '2026-10-01T11:00:00.000Z' }),
        ]),
      ],
      facts(),
    );
    should(found.closures).deepEqual([]);
    should(found.possible).deepEqual([
      {
        kind: 'card',
        members: [
          { sessionId: 's', id: 'A1' },
          { sessionId: 's', id: 'A2' },
        ],
        why: 'not closed: raised by different sessions',
      },
    ]);
  });

  it('reports a gate item and a thread the ferret left on its turn past the grace, and closes neither', () => {
    const found = findDuplicates(
      [
        agenda('s', [
          item('A1', {
            task: { id: 'F1' },
            waitingOn: 'ferret',
            raisedBySession: 'lead',
            waitingSince: '2026-10-01T09:00:00.000Z',
          }),
          item('A2', {
            task: { id: 'F1' },
            gate: gate('F1'),
            raisedBy: 'daemon',
            raisedBySession: null,
            waitingSince: '2026-10-02T11:00:00.000Z',
          }),
        ]),
      ],
      facts(),
    );
    should(found.closures).deepEqual([]);
    should(found.possible).deepEqual([
      {
        kind: 'card',
        members: [
          { sessionId: 's', id: 'A2' },
          { sessionId: 's', id: 'A1' },
        ],
        why: 'not closed: raised by different sessions',
      },
    ]);
  });

  it('ignores a parked item for the owner turn, a notice, a hands-on card, and a card of another machine', () => {
    const found = findDuplicates(
      [
        agenda('s', [
          item('A1', { task: { id: 'F1' }, parked: { until: '2026-12-01T00:00:00.000Z' } }),
          item('A2', { task: { id: 'F1' }, notice: true }),
          item('A3', { task: { id: 'F1' }, input: {} }),
          item('A4', { task: { id: 'F1', machineId: 'other' } }),
          item('A5', { task: { id: 'F1' } }),
          item('A6', { task: { id: 'F1' }, raisedBy: 'human' }),
          item('A7'),
        ]),
      ],
      facts(),
    );
    should(found.closures).deepEqual([{ sessionId: 's', id: 'A1', kind: 'card', keep: { sessionId: 's', id: 'A5' } }]);
  });

  it('never closes an answered gate or an item the owner has begun talking about, and reports them', () => {
    const answered = gate('F1');
    const found = findDuplicates(
      [
        agenda('s', [
          item('A1', { task: { id: 'F1' } }),
          item('A2', { task: { id: 'F1' }, gate: answered, raisedBy: 'daemon', waitingOn: 'ferret' }),
          item('A3', { task: { id: 'F1' }, history: [{}], waitingOn: 'ferret' }),
          item('A4', { task: { id: 'F1' }, infoRequests: [{}], waitingOn: 'ferret' }),
          item('A5', { task: { id: 'F1' }, undelivered: {}, waitingOn: 'ferret' }),
        ]),
      ],
      facts([gateReference(answered)]),
    );
    should(found.closures).deepEqual([]);
    should(found.possible).deepEqual([
      {
        kind: 'card',
        members: ['A1', 'A2', 'A3', 'A4', 'A5'].map(id => ({ sessionId: 's', id })),
        why: 'not closed: a gate the owner answered',
      },
    ]);
  });

  it('closes a gate nobody answered', () => {
    const found = findDuplicates(
      [
        agenda('s', [
          item('A1', { task: { id: 'F1' } }),
          item('A2', { task: { id: 'F1' }, gate: gate('F1'), raisedBy: 'daemon', waitingOn: 'ferret' }),
        ]),
      ],
      facts(['gate:other:x:1']),
    );
    should(found.closures.map(each => each.id)).deepEqual(['A2']);
  });
});

describe('findDuplicates: one source reference open on two agendas', () => {
  it('closes the newer twin, never an item raised by hand, and never across two lineages', () => {
    const source = { source: 'review', sourceRef: 'pr-9' };
    const found = findDuplicates(
      [
        agenda('a', [item('A1', source), item('A2', { ...source, sourceRef: 'pr-10' })], 'a'),
        agenda(
          'b',
          [
            item('A1', { ...source, waitingSince: '2026-10-01T11:00:00.000Z' }),
            item('A3', { source: 'question', sourceRef: 'pr-9' }),
          ],
          'a',
        ),
      ],
      facts(),
    );
    should(found.closures).deepEqual([
      { sessionId: 'b', id: 'A1', kind: 'source', keep: { sessionId: 'a', id: 'A1' } },
    ]);
    const apart = findDuplicates(
      [agenda('a', [item('A1', source)], 'a'), agenda('b', [item('A1', source)], 'b')],
      facts(),
    );
    should(apart).deepEqual({ closures: [], possible: [] });
  });

  it('is nothing when the same reference is open twice on one agenda', () => {
    const source = { source: 'review', sourceRef: 'pr-9' };
    should(findDuplicates([agenda('a', [item('A1', source), item('A2', source)])], facts()).closures).deepEqual([]);
  });
});

describe('findDuplicates: identical titles in one lineage', () => {
  it('closes the newer of two agent-raised twins, ignoring case and punctuation', () => {
    const found = findDuplicates(
      [
        agenda('lead', [item('A1', { subject: 'Ship the release?' })], 'lead'),
        agenda('kid', [item('A2', { subject: 'ship the  release', waitingSince: '2026-10-01T12:00:00.000Z' })], 'lead'),
      ],
      facts(),
    );
    should(found.closures).deepEqual([
      { sessionId: 'kid', id: 'A2', kind: 'title', keep: { sessionId: 'lead', id: 'A1' } },
    ]);
  });

  it('reports twins that share a title but not their ask or body, and closes neither', () => {
    const found = findDuplicates(
      [
        agenda('lead', [item('A1', { subject: 'Ship it', body: 'one way' })], 'lead'),
        agenda('kid', [item('A2', { subject: 'Ship it', body: 'another way' })], 'lead'),
      ],
      facts(),
    );
    should(found.closures).deepEqual([]);
    should(found.possible).deepEqual([
      {
        kind: 'title',
        members: [
          { sessionId: 'lead', id: 'A1' },
          { sessionId: 'kid', id: 'A2' },
        ],
        why: 'not closed: the same title, but a different ask',
      },
    ]);
  });

  it('reports twins whose main tab differs, the live document, and closes neither (review of &F923)', () => {
    const found = findDuplicates(
      [
        agenda('lead', [item('A1', { subject: 'Ship it', whereWeAre: 'Keep SQLite.' })], 'lead'),
        agenda('kid', [item('A2', { subject: 'Ship it', whereWeAre: 'Move to Postgres.' })], 'lead'),
      ],
      facts(),
    );
    should(found.closures).deepEqual([]);
    should(found.possible.map(each => each.why)).deepEqual(['not closed: the same title, but a different ask']);
  });

  it('only reports twins that were not all raised by agents, and keeps lineages apart', () => {
    const found = findDuplicates(
      [
        agenda(
          'lead',
          [item('A1', { subject: 'Same words', raisedBy: 'daemon' }), item('A2', { subject: 'Same words' })],
          'lead',
        ),
        agenda('other', [item('A1', { subject: 'Same words' })], 'other'),
      ],
      facts(),
    );
    should(found.closures).deepEqual([]);
    should(found.possible).deepEqual([
      {
        kind: 'title',
        members: [
          { sessionId: 'lead', id: 'A1' },
          { sessionId: 'lead', id: 'A2' },
        ],
        why: 'the same title, but not all raised by agents',
      },
    ]);
  });

  it('ignores an empty title, a gate item and a hands-on card, and never closes a started conversation', () => {
    const found = findDuplicates(
      [
        agenda('s', [
          item('A1', { subject: '???' }),
          item('A2', { subject: '!!!' }),
          item('A3', { subject: 'Gated', gate: gate('F1') }),
          item('A4', { subject: 'Gated', gate: gate('F1') }),
          item('A5', { subject: 'Hands', input: {} }),
          item('A6', { subject: 'Hands', input: {} }),
          item('A7', { subject: 'Talk' }),
          item('A8', { subject: 'Talk', history: [{}], waitingOn: 'ferret' }),
        ]),
      ],
      facts(),
    );
    should(found.closures).deepEqual([]);
    should(found.possible).deepEqual([
      {
        kind: 'title',
        members: [
          { sessionId: 's', id: 'A7' },
          { sessionId: 's', id: 'A8' },
        ],
        why: 'not closed: the owner has begun talking about it',
      },
    ]);
  });

  it('does not offer an item already closed by an earlier rule to a later one', () => {
    const found = findDuplicates(
      [
        agenda('s', [
          item('A1', { task: { id: 'F1' }, subject: 'Same' }),
          item('A2', { task: { id: 'F1' }, subject: 'Same', waitingSince: '2026-10-01T11:00:00.000Z' }),
        ]),
      ],
      facts(),
    );
    should(found.closures.map(each => each.kind)).deepEqual(['card']);
  });
});
