import { describe, expect, it } from 'bun:test';
import type { AttentionId, AttentionItem } from '@ferretry/protocol';
import { agendaCounts, agendaItems, agendaSegments, nextOwnerItem, sortAgenda } from '../../src/lib/agenda-chat.ts';

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

describe('sortAgenda', () => {
  it('puts blocking first, then what needs the owner, then the ferret’s turn', () => {
    const sorted = sortAgenda([
      item('A1', { waitingOn: 'ferret' }),
      item('A2'),
      item('A3', { blockingNow: true }),
      item('A4', { waitingOn: 'ferret', blockingNow: true }),
    ]);
    expect(ids(sorted)).toEqual(['A3', 'A2', 'A1', 'A4']);
  });

  it('orders a rank by when it is needed, then how long it has waited, then id', () => {
    const sorted = sortAgenda([
      item('A5', { waitingSince: '2026-07-31T11:00:00.000Z' }),
      item('A4', { waitingSince: '2026-07-31T10:00:00.000Z' }),
      item('A3', { neededBy: '2026-08-01T00:00:00.000Z' }),
      item('A2', { neededBy: '2026-07-31T18:00:00.000Z' }),
      item('A1', { waitingSince: '2026-07-31T10:00:00.000Z' }),
    ]);
    expect(ids(sorted)).toEqual(['A2', 'A3', 'A1', 'A4', 'A5']);
  });

  it('leaves its input alone', () => {
    const input = [item('A2'), item('A1', { blockingNow: true })];
    sortAgenda(input);
    expect(ids(input)).toEqual(['A2', 'A1']);
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
    expect(agendaSegments(agendaCounts(board), 'Johnnie')).toEqual(['1 blocking', '3 need you', '2 with Johnnie']);
  });

  it('says plainly that nothing needs the owner when only the ferret has items', () => {
    expect(agendaSegments({ blocking: 0, needYou: 0, withFerret: 2 }, 'Johnnie')).toEqual([
      'Nothing needs you',
      '2 with Johnnie',
    ]);
  });
});

describe('nextOwnerItem', () => {
  const order = [item('A1'), item('A2', { waitingOn: 'ferret' }), item('A3'), item('A4')];

  it('is the next item that needs the owner, skipping the ferret’s', () => {
    expect(nextOwnerItem(order, 'A1' as AttentionId)?.id).toBe('A3');
  });

  it('wraps once to an earlier item', () => {
    expect(nextOwnerItem(order, 'A4' as AttentionId)?.id).toBe('A1');
  });

  it('is null when nothing else needs the owner', () => {
    expect(nextOwnerItem([item('A1'), item('A2', { waitingOn: 'ferret' })], 'A1' as AttentionId)).toBeNull();
  });
});
