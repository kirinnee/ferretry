/**
 * THE ITEM'S ONE ASK, decided in one place (`agenda-item-sections.ts`, &B165): what state an orphan notice is in, which
 * ask goes first when an item asks a question of its own beside a card's try-it, and the one word a card's ask is
 * listed under.
 */
import { describe, expect, test } from 'bun:test';
import type { AgendaGate, AgendaItem } from '@ferretry/protocol';
import { itemAskPlan, itemCardAsks, planAskWord, stateChip } from '../../src/lib/agenda-item-sections.ts';
import { agendaItem } from '../support/agenda-inbox.tsx';

const NOW = Date.parse('2026-08-01T12:00:00.000Z');

const tryGate: AgendaGate = {
  cardId: 'F12',
  laneId: 'tested',
  laneName: 'To test',
  entry: 1,
  projectId: 'p1',
  cardTitle: 'Badge colour',
  options: [
    { id: 'done', label: 'Done', outcome: 'close' },
    { id: 'not-good', label: 'Not good', outcome: 'reopen-with-agenda' },
  ],
} as AgendaGate;
const planGate: AgendaGate = {
  ...tryGate,
  laneId: 'plan',
  laneName: 'Plan',
  options: [{ id: 'ok', label: 'OK to build', outcome: 'next' }],
} as AgendaGate;

describe('the orphan notice', () => {
  test('needs the owner while it is open: its picks are something to do, not news', () => {
    const notice = agendaItem('M4', {
      notice: true,
      kind: 'info',
      subject: '1 card has nobody working on it',
      sourceRef: 'warden:orphans',
      cards: [{ task: { id: 'B1' }, line: '&B1 Fix it is waiting in Review/CI.' }],
    } as never);
    expect(stateChip(notice, 'Zoe', NOW)).toEqual({ state: 'needs-you', label: 'Needs you' });
  });
});

describe('an item that asks a question of its own beside a try-it', () => {
  test('asks its own question first; the try-it waits as the next thing, and nothing is typed into it yet', () => {
    const item = agendaItem('A6', {
      kind: 'reply',
      ask: { kind: 'open-question' },
      subject: 'Should a capacity request wait for the owner?',
      raisedBy: 'agent',
      cardAsks: [{ gate: tryGate, at: '2026-08-01T11:00:00.000Z', howToTest: '1. Look.' }],
    } as unknown as Partial<AgendaItem>);
    const plan = itemAskPlan(item, itemCardAsks(item), { typedHost: true });
    expect(plan.asks).toEqual([]);
    expect(plan.later.map(each => each.gate.cardId)).toEqual(['F12']);
    expect(plan).toMatchObject({ ownFirst: true, ownLine: true, ownAnswered: false, typed: undefined });
  });
});

describe('the one word a card’s ask is listed under', () => {
  test('is Test for a try-it, Approve for a plan, and nothing when no card asks', () => {
    const ask = (gate: AgendaGate) =>
      itemCardAsks(agendaItem('A7', { cardAsks: [{ gate, at: '2026-08-01T11:00:00.000Z' }] } as never));
    expect(planAskWord({ asks: ask(tryGate) })).toBe('Test');
    expect(planAskWord({ asks: ask(planGate) })).toBe('Approve');
    expect(planAskWord({ asks: [] })).toBeUndefined();
  });
});
