import { describe, expect, it } from 'bun:test';
import {
  agendaAuthor,
  agendaStatus,
  clockWords,
  neededByWords,
  nextOwnerItem,
  sortAgenda,
} from '../../src/lib/agenda-status.ts';
import { attentionItem } from '../support/attention-inbox.tsx';

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
    expect(agendaStatus(attentionItem('A1'), 'Johnnie', NOW)).toMatchObject({
      turn: 'owner',
      tone: 'needs-you',
      label: 'Needs you',
      dimmed: false,
    });
  });
  it('prefers Blocking now, then Will block, then the deadline', () => {
    const base = { neededBy: at(29, 17), willBlock: 'the deploy' };
    expect(agendaStatus(attentionItem('A1', { ...base, blockingNow: true }), 'J', NOW)).toMatchObject({
      tone: 'blocking',
      label: 'Blocking now',
      deadline: 'Needed by 17:00',
    });
    expect(agendaStatus(attentionItem('A1', base), 'J', NOW)).toMatchObject({
      tone: 'will-block',
      label: 'Will block: the deploy',
      deadline: 'Needed by 17:00',
    });
    expect(agendaStatus(attentionItem('A1', { neededBy: at(29, 17) }), 'J', NOW)).toMatchObject({
      tone: 'needed-by',
      label: 'Needed by 17:00',
      deadline: null,
    });
  });
  it('flags a deadline that has passed', () => {
    expect(agendaStatus(attentionItem('A1', { neededBy: at(29, 9) }), 'J', NOW)?.overdue).toBe(true);
    expect(agendaStatus(attentionItem('A1', { neededBy: at(29, 17) }), 'J', NOW)?.overdue).toBe(false);
  });
  it("is dimmed 'With <ferret>' on the ferret's turn, and Done once resolved", () => {
    expect(agendaStatus(attentionItem('A1', { waitingOn: 'ferret' }), 'Johnnie', NOW)).toMatchObject({
      turn: 'ferret',
      label: 'With Johnnie',
      dimmed: true,
    });
    const finished = { ...attentionItem('A1'), resolvedAt: at(29, 11) };
    expect(agendaStatus(finished, 'J', NOW)).toMatchObject({
      turn: 'done',
      label: 'Done',
    });
  });
  it('gives a plain notification no status at all', () => {
    expect(agendaStatus(attentionItem('A1', { notice: true }), 'J', NOW)).toBeNull();
  });
});

describe('sortAgenda', () => {
  it('orders blocking, then needs you (nearest deadline, then oldest), then the ferret', () => {
    const items = [
      attentionItem('A1', { waitingOn: 'ferret' }),
      attentionItem('A2', { waitingSince: at(29, 10) }),
      attentionItem('A3', { blockingNow: true, waitingSince: at(29, 11) }),
      attentionItem('A4', { waitingSince: at(29, 9) }),
      attentionItem('A5', { neededBy: at(29, 17), waitingSince: at(29, 11) }),
    ];
    expect(sortAgenda(items).map(item => item.id)).toEqual(['A3', 'A5', 'A4', 'A2', 'A1']);
    expect(items[0]?.id).toBe('A1');
  });
});

describe('nextOwnerItem', () => {
  it("jumps to the next item that is the owner's turn, wrapping round, and none when nothing is left", () => {
    const list = [attentionItem('A1'), attentionItem('A2', { waitingOn: 'ferret' }), attentionItem('A3')];
    expect(nextOwnerItem(list, 'A1')?.id).toBe('A3');
    expect(nextOwnerItem(list, 'A3')?.id).toBe('A1');
    expect(nextOwnerItem([attentionItem('A1')], 'A1')).toBeNull();
  });
});

describe('agendaAuthor', () => {
  it('says Warden for the daemon’s Warden asks, else the ferret', () => {
    expect(agendaAuthor({ raisedBy: 'daemon', sourceRef: 'warden:verdict-1' }, 'Johnnie')).toBe('Warden');
    expect(agendaAuthor({ raisedBy: 'daemon', sourceRef: 'push:x' }, 'Johnnie')).toBe('Johnnie');
    expect(agendaAuthor({ raisedBy: 'agent', sourceRef: 'warden:x' }, 'Johnnie')).toBe('Johnnie');
  });
});
