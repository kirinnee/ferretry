import { describe, expect, test } from 'bun:test';
import type { AgendaItem, ResolvedAgendaItem } from '@ferretry/core-asks/contract';
import { AGENDA_TAB_FILTERS, agendaSummary, agendaTabModel } from '../../../app/lib/agenda-tab.ts';
import { agendaItem } from '../../support/app/agenda-inbox.tsx';

const NOW = Date.parse('2026-08-01T12:00:00.000Z');
const at = (minutesAgo: number): string => new Date(NOW - minutesAgo * 60_000).toISOString();

const make = (id: string, extra: Record<string, unknown> = {}): AgendaItem =>
  agendaItem(id, { ask: { kind: 'permission' }, ...extra } as Partial<AgendaItem>);

const resting = (id: string, sub: 'waiting-on-ferret' | 'working', minutesAgo: number): AgendaItem =>
  make(id, { waitingOn: 'ferret', askedAt: at(minutesAgo), resting: { sub, at: at(minutesAgo) } });

const snoozed = (id: string, wake: string): AgendaItem =>
  make(id, { parked: { reason: 'snoozed', at: at(30), until: wake } });

const done = (id: string, resolvedAt: string): ResolvedAgendaItem =>
  ({ ...make(id), resolvedAt }) as unknown as ResolvedAgendaItem;

const model = (items: readonly AgendaItem[], resolved: readonly ResolvedAgendaItem[] = []) =>
  agendaTabModel({ items, resolved, ferret: 'Johnnie', now: NOW });

const ids = (rows: readonly { id: string }[]): string[] => rows.map(each => each.id);

describe('agendaTabModel', () => {
  test('has the four filters in order and a count equal to each row list', () => {
    const built = model(
      [make('A1', { waitingSince: at(10) }), resting('A2', 'working', 5), snoozed('A3', '2026-08-02T09:00:00.000Z')],
      [done('A4', at(60))],
    );
    expect(built.chips.map(chip => chip.key)).toEqual([...AGENDA_TAB_FILTERS]);
    expect(built.chips.map(chip => chip.label)).toEqual(['Needs you', 'Resting', 'Snoozed', 'Resolved']);
    for (const chip of built.chips) expect(chip.count).toBe(built.rows[chip.key].length);
    expect(built.chips.map(chip => chip.count)).toEqual([1, 1, 1, 1]);
  });

  test('puts each item on exactly one filter', () => {
    const items = [make('A1'), resting('A2', 'waiting-on-ferret', 5), snoozed('A3', '2026-08-02T09:00:00.000Z')];
    const built = model(items, [done('A4', at(60))]);
    const all = AGENDA_TAB_FILTERS.flatMap(key => ids(built.rows[key]));
    expect(all.sort()).toEqual(['A1', 'A2', 'A3', 'A4']);
  });

  test('orders Needs you blockers first, then by how long each has waited, each item once', () => {
    const built = model([
      make('A1', { waitingSince: at(5) }),
      make('A2', { waitingSince: at(50) }),
      make('A3', { waitingSince: at(1), blockingNow: true }),
      make('A2', { waitingSince: at(90) }),
    ]);
    expect(ids(built.rows['needs-you'])).toEqual(['A3', 'A2', 'A1']);
    expect(built.rows['needs-you'][0]?.blocking).toBe(true);
    expect(built.rows['needs-you'][1]?.blocking).toBe(false);
  });

  test('marks an open card ask as a blocker', () => {
    const built = model([
      make('A1', { waitingSince: at(50) }),
      make('A2', { waitingSince: at(5), cardAsks: [{ id: 'C1', prompt: 'Run it?' }] }),
    ]);
    expect(ids(built.rows['needs-you'])).toEqual(['A2', 'A1']);
    expect(built.rows['needs-you'][0]?.blocking).toBe(true);
  });

  test('orders Resting waiting-on-ferret before working and words each state', () => {
    const built = model([
      resting('A1', 'working', 30),
      resting('A2', 'waiting-on-ferret', 5),
      resting('A3', 'waiting-on-ferret', 40),
    ]);
    expect(ids(built.rows.resting)).toEqual(['A3', 'A2', 'A1']);
    expect(built.rows.resting.map(row => row.state)).toEqual([
      'Resting · waiting on Johnnie',
      'Resting · waiting on Johnnie',
      'Resting · working',
    ]);
  });

  test('orders Snoozed by wake time and says when each wakes', () => {
    const built = model([
      snoozed('A1', '2026-08-03T09:00:00.000Z'),
      snoozed('A2', '2026-08-02T09:00:00.000Z'),
      snoozed('A3', '2026-08-02T15:00:00.000Z'),
    ]);
    expect(ids(built.rows.snoozed)).toEqual(['A2', 'A3', 'A1']);
    for (const row of built.rows.snoozed) expect(row.state).toMatch(/^Snoozed until /);
  });

  test('orders Resolved newest first and says Done', () => {
    const built = model([], [done('A1', at(300)), done('A2', at(10)), done('A3', at(120))]);
    expect(ids(built.rows.resolved)).toEqual(['A2', 'A3', 'A1']);
    expect(built.rows.resolved.every(row => row.state === 'Done')).toBe(true);
  });

  test('leaves plain notifications out of every filter', () => {
    const built = model([make('A1', { notice: true }), make('A2')]);
    expect(AGENDA_TAB_FILTERS.flatMap(key => ids(built.rows[key]))).toEqual(['A2']);
  });

  test('names the stage and the age on each row', () => {
    const built = model([make('A1', { waitingSince: at(3) })], [done('A2', at(120))]);
    expect(built.rows['needs-you'][0]?.stage).toBeTruthy();
    expect(built.rows['needs-you'][0]?.since).toBe('3m ago');
    expect(built.rows.resolved[0]?.since).toBe('2h ago');
    expect(built.rows.resolved[0]?.stage).not.toBe('Done');
  });

  test('names a closed item by the last stage it had before the daemon wrote done', () => {
    const closed = (id: string, extra: Record<string, unknown>): ResolvedAgendaItem =>
      ({ ...make(id), resolvedAt: at(5), ...extra }) as unknown as ResolvedAgendaItem;
    const built = model(
      [],
      [
        closed('A1', {
          stage: 'done',
          stages: [
            { stage: 'plan', at: at(300) },
            { stage: 'tracker', at: at(200) },
            { stage: 'test', at: at(100) },
            { stage: 'done', at: at(5) },
          ],
        }),
        closed('A2', {
          stage: 'done',
          stages: [
            { stage: 'plan', at: at(200) },
            { stage: 'done', at: at(6) },
          ],
        }),
        closed('A3', { stage: 'done', stages: [{ stage: 'done', at: at(7) }] }),
        closed('A4', { stage: 'tracker' }),
      ],
    );
    const stages = Object.fromEntries(built.rows.resolved.map(row => [row.id, row.stage]));
    expect(stages).toEqual({ A1: 'Test', A2: 'Plan to approve', A3: 'Plan to approve', A4: 'Tracker' });
    expect(built.rows.resolved.map(row => row.state)).toEqual(['Done', 'Done', 'Done', 'Done']);
  });

  test('is empty and total on an empty board', () => {
    const built = model([]);
    expect(built.chips.map(chip => chip.count)).toEqual([0, 0, 0, 0]);
  });

  test("scopes to the lineage: it shows the board it is handed — a lead's own agenda holds its sub-ferrets' items", () => {
    const own = make('A1', { raisedBySession: 'lead' });
    const sub = make('A2', { raisedBySession: 'sub-ferret' });
    expect(ids(model([own, sub]).rows['needs-you']).sort()).toEqual(['A1', 'A2']);
    expect(ids(model([own]).rows['needs-you'])).toEqual(['A1']);
  });
});

describe('agendaSummary', () => {
  test('says the four counts in one line', () => {
    expect(agendaSummary({ 'needs-you': 2, resting: 1, snoozed: 0, resolved: 5 })).toBe(
      '2 need you · 1 resting · 0 snoozed · 5 resolved',
    );
  });
  test('says needs for one', () => {
    expect(agendaSummary({ 'needs-you': 1, resting: 0, snoozed: 0, resolved: 0 })).toStartWith('1 needs you');
  });
});
