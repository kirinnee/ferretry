import { describe, it } from 'bun:test';
import should from 'should';
import { draftsLanded, type AgendaVersionDraft } from '../../../../daemon/lib/agenda/versions.ts';

const AT = '2026-11-03T10:00:00.000Z';
const SINCE = '2026-11-03T09:00:00.000Z';

const draft = (change: string, item: Record<string, unknown> = {}): AgendaVersionDraft =>
  ({
    entry: { item: { id: 'A1', waitingSince: SINCE, subject: 'Subject', raisedBy: 'ferret', ...item } },
    at: AT,
    by: 'ferret',
    change,
  }) as unknown as AgendaVersionDraft;

const file = (...items: Record<string, unknown>[]): string =>
  JSON.stringify({ entries: items.map(item => ({ item: { id: 'A1', waitingSince: SINCE, ...item } })) });

describe('whether a prepared agenda change reached the file', () => {
  it('should say no for a file that is missing, unreadable or the wrong shape', () => {
    // Arrange
    const drafts = [draft('created')];

    // Act
    const results = [undefined, 'not json', '{"entries":"nope"}', '[]'].map(text => draftsLanded(text, drafts));

    // Assert
    should(results).eql([false, false, false, false]);
  });

  it('should say no when the item is not in the file or is another item with the same id', () => {
    // Arrange
    const drafts = [draft('created')];

    // Act
    const missing = draftsLanded(file({ id: 'A2', subject: 'Subject' }), drafts);
    const other = draftsLanded(file({ subject: 'Subject', waitingSince: '2020-01-01T00:00:00.000Z' }), drafts);
    const unreadable = draftsLanded(JSON.stringify({ entries: [{ item: 3 }, 'x'] }), drafts);

    // Assert
    should([missing, other, unreadable]).eql([false, false, false]);
  });

  it('should find a created item by its subject', () => {
    // Arrange
    const drafts = [draft('created')];

    // Act
    const same = draftsLanded(file({ subject: 'Subject' }), drafts);
    const different = draftsLanded(file({ subject: 'Elsewhere' }), drafts);

    // Assert
    should([same, different]).eql([true, false]);
  });

  it('should find another change by its time on the history, the revisions, the answer or the closing', () => {
    // Arrange
    const drafts = [draft('edited')];
    const marks = [
      { history: [{ at: AT }] },
      { revisions: [{ at: AT }] },
      { ownerAnswer: { at: AT } },
      { resolvedAt: AT },
    ];

    // Act
    const found = marks.map(mark => draftsLanded(file({ subject: 'Subject', ...mark }), drafts));
    const unmarked = draftsLanded(
      file({ subject: 'Subject', history: [{ at: SINCE }], revisions: [{ at: SINCE }], ownerAnswer: { at: SINCE } }),
      drafts,
    );
    const bare = draftsLanded(file({ subject: 'Subject' }), drafts);

    // Assert
    should(found).eql([true, true, true, true]);
    should([unmarked, bare]).eql([false, false]);
  });

  it('should not count a mark on an item whose subject and raiser were both rewritten', () => {
    // Arrange
    const drafts = [draft('edited')];

    // Act
    const rewritten = draftsLanded(file({ subject: 'Else', raisedBy: 'owner', history: [{ at: AT }] }), drafts);
    const raiserKept = draftsLanded(file({ subject: 'Else', raisedBy: 'ferret', history: [{ at: AT }] }), drafts);

    // Assert
    should([rewritten, raiserKept]).eql([false, true]);
  });

  it('should count one marked draft as the whole intent landing', () => {
    // Arrange
    const drafts = [draft('linked', { id: 'A9' }), draft('edited')];

    // Act
    const landed = draftsLanded(file({ subject: 'Subject', history: [{ at: AT }] }), drafts);

    // Assert
    should(landed).be.true();
  });
});
