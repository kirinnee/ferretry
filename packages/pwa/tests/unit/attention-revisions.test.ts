import { describe, expect, it } from 'bun:test';
import type { AttentionItem, AttentionRevision } from '@ferretry/protocol';
import {
  decidedSummary,
  describePrevious,
  hasHighlight,
  lastRevision,
  revisionHighlight,
  revisionList,
  revisionStamp,
  updatedAgo,
} from '../../src/lib/attention-revisions.ts';
import { attentionItem } from '../support/attention-inbox.tsx';

const revision = (over: Partial<AttentionRevision> & Pick<AttentionRevision, 'changed'>): AttentionRevision =>
  ({ at: '2026-08-01T11:55:00.000Z', by: 'agent', previous: {}, ...over }) as AttentionRevision;

const withRevisions = (revisions: AttentionRevision[], over: Partial<AttentionItem> = {}): AttentionItem =>
  attentionItem('A5', { ...over, revisions });

const NOW = Date.parse('2026-08-01T12:00:00.000Z');

describe('updatedAgo', () => {
  it('is null for an item never edited', () => {
    expect(updatedAgo(attentionItem('A5'), NOW)).toBeNull();
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
    expect(hasHighlight(revisionHighlight(attentionItem('A5')))).toBe(false);
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

  it('says nothing for an item never edited', () => {
    expect(revisionList(attentionItem('A5'))).toEqual([]);
  });
});

describe('describePrevious', () => {
  it('reads text as itself, an empty field as null, a text list as points and a list by its size', () => {
    expect(describePrevious('why', 'Because')).toBe('Because');
    expect(describePrevious('why', undefined)).toBeNull();
    expect(describePrevious('terms', [{ term: 'a', meaning: 'b' }])).toBe('1 term');
    expect(describePrevious('links', [{ target: 'x' }, { target: 'y' }])).toBe('2 entries');
    expect(describePrevious('steps', ['one', 'two'])).toBe('- one\n- two');
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
