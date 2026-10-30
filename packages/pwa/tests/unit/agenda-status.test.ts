import { describe, expect, it } from 'bun:test';
import {
  agendaAuthor,
  agendaStatus,
  clockWords,
  parkedWords,
  neededByWords,
  nextOwnerItem,
  sortAgenda,
} from '../../src/lib/agenda-status.ts';
import { agendaItem } from '../support/agenda-inbox.tsx';

const NOW = new Date(2026, 9, 29, 12, 0).getTime();
const at = (day: number, hour: number, minute = 0): string => new Date(2026, 9, day, hour, minute).toISOString();

describe('clockWords', () => {
  it('says a deadline the way a person does', () => {
    expect(clockWords(at(29, 17), NOW)).toBe('17:00');
    expect(clockWords(at(30, 9, 30), NOW)).toBe('tomorrow 09:30');
    expect(clockWords(new Date(2026, 10, 2, 8).toISOString(), NOW)).toBe('Mon 08:00');
    expect(clockWords(new Date(2026, 10, 12, 8, 5).toISOString(), NOW)).toBe('12 Nov 08:05');
    expect(clockWords('nonsense', NOW)).toBeNull();
  });
  it('reads neededBy as "Needed by …"', () => {
    expect(neededByWords({ neededBy: at(29, 17) }, NOW)).toBe('Needed by 17:00');
    expect(neededByWords({}, NOW)).toBeNull();
  });
});

describe('agendaStatus', () => {
  it('is the owner turn "Needs you" for a plain open item', () => {
    expect(agendaStatus(agendaItem('A1'), 'Johnnie', NOW)).toMatchObject({
      turn: 'owner',
      tone: 'needs-you',
      label: 'Needs you',
      dimmed: false,
    });
  });
  it('prefers Blocking now, then Will block, then the deadline', () => {
    const base = { neededBy: at(29, 17), willBlock: 'the deploy' };
    expect(agendaStatus(agendaItem('A1', { ...base, blockingNow: true }), 'J', NOW)).toMatchObject({
      tone: 'blocking',
      label: 'Blocking now',
      deadline: 'Needed by 17:00',
    });
    expect(agendaStatus(agendaItem('A1', base), 'J', NOW)).toMatchObject({
      tone: 'will-block',
      label: 'Will block: the deploy',
      deadline: 'Needed by 17:00',
    });
    expect(agendaStatus(agendaItem('A1', { neededBy: at(29, 17) }), 'J', NOW)).toMatchObject({
      tone: 'needed-by',
      label: 'Needed by 17:00',
      deadline: null,
    });
  });
  it('flags a deadline that has passed', () => {
    expect(agendaStatus(agendaItem('A1', { neededBy: at(29, 9) }), 'J', NOW)?.overdue).toBe(true);
    expect(agendaStatus(agendaItem('A1', { neededBy: at(29, 17) }), 'J', NOW)?.overdue).toBe(false);
  });
  it("is dimmed 'With <ferret>' on the ferret's turn, and Done once resolved", () => {
    expect(agendaStatus(agendaItem('A1', { waitingOn: 'ferret' }), 'Johnnie', NOW)).toMatchObject({
      turn: 'ferret',
      label: 'With Johnnie',
      dimmed: true,
    });
    const finished = { ...agendaItem('A1'), resolvedAt: at(29, 11) };
    expect(agendaStatus(finished, 'J', NOW)).toMatchObject({
      turn: 'done',
      label: 'Done',
    });
  });
  it('gives a plain notification no status at all', () => {
    expect(agendaStatus(agendaItem('A1', { notice: true }), 'J', NOW)).toBeNull();
  });
});

describe('sortAgenda', () => {
  it('orders blocking, needed-by, will-block, plain needs you, then the ferret', () => {
    const items = [
      agendaItem('A1', { waitingOn: 'ferret' }),
      agendaItem('A2', { waitingSince: at(29, 10) }),
      agendaItem('A3', { blockingNow: true, waitingSince: at(29, 11) }),
      agendaItem('A4', { waitingSince: at(29, 9) }),
      agendaItem('A5', { neededBy: at(29, 17), waitingSince: at(29, 11) }),
      agendaItem('A6', { willBlock: 'the release', waitingSince: at(29, 12) }),
      agendaItem('A7', { neededBy: at(29, 15), waitingSince: at(29, 12) }),
    ];
    expect(sortAgenda(items).map(item => item.id)).toEqual(['A3', 'A7', 'A5', 'A6', 'A4', 'A2', 'A1']);
    expect(items[0]?.id).toBe('A1');
  });
});

describe('nextOwnerItem', () => {
  it("jumps to the next item that is the owner's turn, wrapping round, and none when nothing is left", () => {
    const list = [agendaItem('A1'), agendaItem('A2', { waitingOn: 'ferret' }), agendaItem('A3')];
    expect(nextOwnerItem(list, 'A1')?.id).toBe('A3');
    expect(nextOwnerItem(list, 'A3')?.id).toBe('A1');
    expect(nextOwnerItem([agendaItem('A1')], 'A1')).toBeNull();
  });
});

describe('agendaAuthor', () => {
  it('says Warden for the daemon’s Warden asks, else the ferret', () => {
    expect(agendaAuthor({ raisedBy: 'daemon', sourceRef: 'warden:verdict-1' }, 'Johnnie')).toBe('Warden');
    expect(agendaAuthor({ raisedBy: 'daemon', sourceRef: 'push:x' }, 'Johnnie')).toBe('Johnnie');
    expect(agendaAuthor({ raisedBy: 'agent', sourceRef: 'warden:x' }, 'Johnnie')).toBe('Johnnie');
  });
});

describe('parked items', () => {
  const snoozed = (until: string, extra: Record<string, unknown> = {}) =>
    agendaItem('A1', { parked: { reason: 'snoozed', at: at(29, 11), until }, ...extra } as never);
  const replied = (when: string) => agendaItem('A1', { parked: { reason: 'replied', at: when } } as never);

  it('says when a snoozed item comes back', () => {
    expect(agendaStatus(snoozed(at(30, 15)), 'Johnnie', NOW)).toEqual({
      turn: 'parked',
      tone: 'parked',
      label: 'Snoozed until tomorrow 15:00',
      deadline: null,
      overdue: false,
      dimmed: true,
    });
  });

  it('says the sooner of the wake time and the deadline', () => {
    expect(parkedWords(snoozed(at(30, 15), { neededBy: at(29, 17) }), 'J', NOW)).toBe('Snoozed until 17:00');
  });

  it('says only "Snoozed" when the instant cannot be read', () => {
    expect(parkedWords(snoozed('nonsense'), 'J', NOW)).toBe('Snoozed');
  });

  it('says who a replied item waits on, and when it was replied to', () => {
    expect(agendaStatus(replied(at(29, 14, 2)), 'Johnnie', NOW)).toMatchObject({
      turn: 'parked',
      tone: 'parked',
      label: 'Replied 14:02 — waiting on Johnnie',
    });
    expect(parkedWords(replied('nonsense'), 'Johnnie', NOW)).toBe('Replied — waiting on Johnnie');
  });

  it('says nothing for an item that is not parked', () => {
    expect(parkedWords(agendaItem('A1'), 'J', NOW)).toBe('');
  });

  it('sorts parked items after the ferret’s and before the done ones', () => {
    const items = [
      { ...agendaItem('A1'), resolvedAt: at(29, 11) },
      snoozed(at(30, 15)),
      agendaItem('A3', { waitingOn: 'ferret' }),
      agendaItem('A4'),
    ].map((entry, index) => ({ ...entry, id: `A${index + 1}` }) as typeof entry);
    expect(sortAgenda(items).map(entry => entry.id)).toEqual(['A4', 'A3', 'A2', 'A1']);
  });
});
