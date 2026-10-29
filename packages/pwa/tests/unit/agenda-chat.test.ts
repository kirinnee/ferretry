import { describe, expect, it } from 'bun:test';
import type { AttentionId, AttentionItem } from '@ferretry/protocol';
import { agendaCounts, agendaItems, agendaSegments } from '../../src/lib/agenda-chat.ts';

const item = (id: string, extra: Record<string, unknown> = {}): AttentionItem =>
  ({
    id: id as AttentionId,
    source: 'agent-raised',
    subject: `Ask ${id}`,
    waitingSince: '2026-07-31T11:30:00.000Z',
    ask: { kind: 'permission' },
    ...extra,
  }) as unknown as AttentionItem;

const ids = (items: readonly AttentionItem[]): readonly string[] => items.map(entry => entry.id);

describe('agendaItems', () => {
  it('keeps what is open and drops notifications and finished items', () => {
    const items = [item('A1'), item('A2', { notice: true }), item('A3', { resolvedAt: '2026-07-31T12:00:00.000Z' })];
    expect(ids(agendaItems(items))).toEqual(['A1']);
  });
});

describe('agendaCounts and agendaSegments', () => {
  const board = [
    item('A1', { blockingNow: true }),
    item('A2'),
    item('A3'),
    item('A4', { waitingOn: 'ferret' }),
    item('A5', { waitingOn: 'ferret' }),
  ];

  it('counts what blocks, what needs the owner (blocking included) and what waits on the ferret', () => {
    expect(agendaCounts(board)).toEqual({ blocking: 1, needYou: 3, withFerret: 2 });
  });

  it('says it in segments, blocking first, with the ferret by name', () => {
    expect(agendaSegments(agendaCounts(board), 'Johnnie')).toEqual([
      { count: 1, words: 'blocking' },
      { count: 3, words: 'need you' },
      { count: 2, words: 'with Johnnie' },
    ]);
  });

  it('says plainly that nothing needs the owner when only the ferret has items', () => {
    expect(agendaSegments({ blocking: 0, needYou: 0, withFerret: 2 }, 'Johnnie')).toEqual([
      { count: null, words: 'Nothing needs you' },
      { count: 2, words: 'with Johnnie' },
    ]);
  });
});
