import { describe, expect, it } from 'bun:test';
import type { AgendaItem, AgendaRevision } from '@ferretry/protocol';
import {
  decidedSummary,
  describePrevious,
  hasHighlight,
  itemVersions,
  lastRevision,
  revisionHighlight,
  revisionList,
  revisionStamp,
  updatedAgo,
  versionText,
} from '../../src/lib/agenda-revisions.ts';
import { agendaItem } from '../support/agenda-inbox.tsx';

const revision = (over: Partial<AgendaRevision> & Pick<AgendaRevision, 'changed'>): AgendaRevision =>
  ({ at: '2026-08-01T11:55:00.000Z', by: 'agent', previous: {}, ...over }) as AgendaRevision;

const withRevisions = (revisions: AgendaRevision[], over: Partial<AgendaItem> = {}): AgendaItem =>
  agendaItem('A5', { ...over, revisions });

const NOW = Date.parse('2026-08-01T12:00:00.000Z');

describe('updatedAgo', () => {
  it('is null for an item never edited', () => {
    expect(updatedAgo(agendaItem('A5'), NOW)).toBeNull();
  });

  it('says how long ago the LAST revision was, in the coarsest unit that fits', () => {
    const item = withRevisions([
      revision({ at: '2026-07-30T12:00:00.000Z', changed: ['why'] }),
      revision({ at: '2026-08-01T11:55:00.000Z', changed: ['why'] }),
    ]);
    expect(updatedAgo(item, NOW)).toBe('Updated 5 min ago');
    expect(updatedAgo(item, NOW - 4 * 60_000 - 40_000)).toBe('Updated just now');
    expect(updatedAgo(item, NOW + 3 * 3_600_000)).toBe('Updated 3 hours ago');
    expect(updatedAgo(item, NOW + 2 * 86_400_000)).toBe('Updated 2 days ago');
  });
});

describe('revisionHighlight', () => {
  it('marks nothing for an item never edited', () => {
    expect(hasHighlight(revisionHighlight(agendaItem('A5')))).toBe(false);
  });

  it('marks, in a point-form field, only the bullets the last edit added or reworded', () => {
    const item = withRevisions(
      [revision({ changed: ['decided'], previous: { decided: '- Use SQLite\n- Ship Friday' } })],
      { decided: '- Use SQLite\n- Ship Monday\n- Add a rollback step' },
    );
    const { points, fields } = revisionHighlight(item);
    expect([...(points.decided ?? [])]).toEqual(['Ship Monday', 'Add a rollback step']);
    expect(fields.size).toBe(0);
  });

  it('treats a point-form field that was absent before as all new', () => {
    const item = withRevisions([revision({ changed: ['stillOpen'] })], { stillOpen: '- Who owns it?\n- By when?' });
    expect([...(revisionHighlight(item).points.stillOpen ?? [])]).toEqual(['Who owns it?', 'By when?']);
  });

  it('marks nothing in a field the edit only shrank', () => {
    const item = withRevisions([revision({ changed: ['stillOpen'], previous: { stillOpen: '- A\n- B' } })], {
      stillOpen: '- A',
    });
    expect(hasHighlight(revisionHighlight(item))).toBe(false);
  });

  it('marks a prose field whole, and only what the LAST revision changed', () => {
    const item = withRevisions(
      [
        revision({ changed: ['subject'], previous: { subject: 'Old' } }),
        revision({ at: '2026-08-01T11:58:00.000Z', changed: ['why'], previous: { why: 'Before' } }),
      ],
      { why: 'After' },
    );
    expect([...revisionHighlight(item).fields]).toEqual(['why']);
  });

  it('marks a point-form field that is now prose as changed whole', () => {
    const item = withRevisions([revision({ changed: ['context'], previous: { context: '- a' } })], {
      context: 'Now a paragraph.',
    });
    expect([...revisionHighlight(item).fields]).toEqual(['context']);
  });
});

describe('decidedSummary', () => {
  it('counts the points of each list, and says nothing when there are none', () => {
    expect(decidedSummary({ decided: '- a\n- b\n- c', stillOpen: '- x\n- y' })).toBe('3 decided · 2 still open');
    expect(decidedSummary({ stillOpen: '- x' })).toBe('1 still open');
    expect(decidedSummary({ decided: 'one paragraph' })).toBe('1 decided');
    expect(decidedSummary({})).toBeNull();
  });
});

describe('revisionList', () => {
  it('lists the earlier versions newest first, with who, which fields and what they said', () => {
    const item = withRevisions([
      revision({
        at: '2026-07-30T00:00:00.000Z',
        by: 'human',
        changed: ['subject'],
        previous: { subject: 'Which db?' },
      }),
      revision({
        at: '2026-08-01T11:55:00.000Z',
        changed: ['stillOpen', 'ask'],
        previous: { ask: { kind: 'open-question' } },
      }),
    ]);
    const list = revisionList(item);
    expect(list.map(entry => [entry.at, entry.by])).toEqual([
      ['2026-08-01T11:55:00.000Z', 'agent'],
      ['2026-07-30T00:00:00.000Z', 'human'],
    ]);
    expect(list[0]?.changed).toEqual([
      { field: 'stillOpen', label: 'Still open', before: null },
      { field: 'ask', label: 'Answer type', before: 'open question' },
    ]);
    expect(list[1]?.changed[0]?.before).toBe('Which db?');
    expect(lastRevision(item)?.at).toBe('2026-08-01T11:55:00.000Z');
  });

  it('names an edited option explanation "Option details" and counts what it replaced', () => {
    // Arrange
    const item = withRevisions([
      revision({
        changed: ['optionDetails'],
        previous: { optionDetails: [{ label: 'SQLite', detail: 'One file' }] },
      }),
    ]);

    // Act
    const [entry] = revisionList(item);

    // Assert
    expect(entry?.changed).toEqual([{ field: 'optionDetails', label: 'Option details', before: '1 entry' }]);
  });

  it('says nothing for an item never edited', () => {
    expect(revisionList(agendaItem('A5'))).toEqual([]);
  });
});

describe('describePrevious', () => {
  it('reads text as itself, an empty field as null, a text list as points and a list by its size', () => {
    expect(describePrevious('why', 'Because')).toBe('Because');
    expect(describePrevious('why', undefined)).toBeNull();
    expect(describePrevious('terms', [{ term: 'a', meaning: 'b' }])).toBe('1 term');
    expect(describePrevious('links', [{ target: 'x' }, { target: 'y' }])).toBe('2 entries');
    expect(describePrevious('steps', ['one', 'two'])).toBe('- one\n- two');
    expect(describePrevious('ask', { decision: 'Postgres' })).toBe('Postgres');
    expect(describePrevious('ask', { other: 1 })).toBe('Changed');
  });
});

describe('revisionStamp', () => {
  const now = new Date(2026, 9, 29, 12, 0).getTime();
  const local = (month: number, day: number, hour: number, minute: number): string =>
    new Date(2026, month, day, hour, minute).toISOString();
  it('is the clock today, weekday and clock within the week, else month and day', () => {
    expect(revisionStamp(local(9, 29, 8, 54), now)).toBe('8:54');
    expect(revisionStamp(local(9, 26, 8, 4), now)).toBe('Mon 8:04');
    expect(revisionStamp(local(9, 1, 8, 54), now)).toBe('Oct 1');
    expect(revisionStamp('nonsense', now)).toBe('nonsense');
  });
});

describe('versionText', () => {
  it('reads an ask as its options, terms and details as "Term — meaning" bullets, a recommendation as decision — why', () => {
    expect(versionText('ask', { kind: 'multiple-choice', options: [{ label: 'SQLite' }, { label: 'Postgres' }] })).toBe(
      '- SQLite\n- Postgres',
    );
    expect(versionText('terms', [{ term: 'WAL', meaning: 'x'.repeat(120) }])).toBe(`- WAL — ${'x'.repeat(90)}…`);
    expect(versionText('optionDetails', [{ label: 'SQLite', detail: 'one file' }, { label: 'Postgres' }])).toBe(
      '- SQLite — one file\n- Postgres — ',
    );
    expect(versionText('recommendation', { decision: 'SQLite', why: 'No server.' })).toBe('SQLite — No server.');
    expect(versionText('recommendation', { decision: 'SQLite' })).toBe('SQLite');
  });

  it('falls back to the plain reading for everything else, an ask without options included', () => {
    expect(versionText('premise', 'The board outgrew its file.')).toBe('The board outgrew its file.');
    expect(versionText('premise', undefined)).toBeNull();
    expect(versionText('ask', { kind: 'open-question' })).toBe(describePrevious('ask', { kind: 'open-question' }));
    expect(versionText('ask', { kind: 'multiple-choice', options: [{ label: 7 }] })).toBe(
      describePrevious('ask', { kind: 'multiple-choice', options: [{ label: 7 }] }),
    );
    expect(versionText('terms', [])).toBe(describePrevious('terms', []));
    expect(versionText('optionDetails', [])).toBe(describePrevious('optionDetails', []));
  });
});

describe('itemVersions', () => {
  it('is only v1 for an item never edited', () => {
    expect(itemVersions(agendaItem('A5'))).toEqual([{ number: 1, at: null, by: null, changes: [] }]);
  });

  it('lists v1, then one version per edit newest first, each field before → after', () => {
    const item = withRevisions(
      [
        revision({
          at: '2026-08-01T10:00:00.000Z',
          changed: ['premise', 'context'],
          previous: { premise: 'one', context: 'old' },
        }),
        revision({ at: '2026-08-01T11:00:00.000Z', by: 'human', changed: ['premise'], previous: { premise: 'two' } }),
      ],
      { premise: 'three', context: 'newer' },
    );
    const versions = itemVersions(item);
    expect(versions.map(version => version.number)).toEqual([3, 2, 1]);
    expect(versions[0]).toMatchObject({ by: 'human', at: '2026-08-01T11:00:00.000Z' });
    expect(versions[0]?.changes).toEqual([
      { field: 'premise', label: "What's going on", before: 'two', after: 'three' },
    ]);
    expect(versions[1]?.changes).toEqual([
      { field: 'premise', label: "What's going on", before: 'one', after: 'two' },
      { field: 'context', label: 'Why now', before: 'old', after: 'newer' },
    ]);
    expect(versions[2]).toEqual({ number: 1, at: null, by: null, changes: [] });
  });
});
