import { describe, expect, test } from 'bun:test';
import { sessionCards, resolveCardReference } from '../../src/lib/session-cards.ts';
import { boardModelOf, card, laptop, phone } from './board-support.ts';

const SESSION = 'session-a';

describe('sessionCards', () => {
  test('keeps the cards this ferret owns or is assigned, on this machine, newest activity first', async () => {
    const model = await boardModelOf([
      card('F1', { owner: SESSION, lastTouchedAt: '2026-08-01T09:00:00.000Z' }),
      card('F2', { owner: 'someone-else', assignee: SESSION, lastTouchedAt: '2026-08-02T09:00:00.000Z' }),
      card('F3', { owner: 'someone-else' }),
    ]);

    const cards = sessionCards(model, laptop.daemonId, SESSION);

    expect(cards.map(entry => entry.id).sort()).toEqual(['F1', 'F2']);
    expect(sessionCards(model, phone.daemonId, SESSION)).toEqual([]);
  });

  test('carries the old id only from a legacyRef that names this session', async () => {
    const model = await boardModelOf([
      card('F96', { owner: SESSION, legacyRef: `${SESSION}:F12` }),
      card('F97', { owner: SESSION, legacyRef: 'session-b:F12' }),
      card('F98', { owner: SESSION }),
    ]);

    const byId = new Map(sessionCards(model, laptop.daemonId, SESSION).map(entry => [entry.id, entry]));

    expect(byId.get('F96')?.legacyId).toBe('F12');
    expect(byId.get('F97')?.legacyId).toBeNull();
    expect(byId.get('F98')?.legacyId).toBeNull();
  });

  test('says a dropped card is closed and a card with no activity falls back to its creation instant', async () => {
    const model = await boardModelOf([
      card('F1', {
        owner: SESSION,
        dropped: { at: '2026-08-01T11:00:00.000Z', reason: 'no' },
        lastTouchedAt: null,
      }),
    ]);

    const [only] = sessionCards(model, laptop.daemonId, SESSION);

    expect(only?.closed).toBe(true);
    expect(only?.touchedAt).toBe('2026-08-01T09:00:00.000Z');
  });
});

describe('resolveCardReference', () => {
  const cards = [
    { id: 'F12' },
    { id: 'F96', legacyId: 'F12' },
    { id: 'F97', legacyId: 'F7' },
    { id: 'F98', legacyId: null },
  ];

  test('lets a card on the slice win over an imported task that used the same old id', () => {
    expect(resolveCardReference(cards, 'f12')).toBe('F12');
  });

  test('falls back to the old id, case-insensitively, and gives up on a stranger', () => {
    expect(resolveCardReference(cards, 'f7')).toBe('F97');
    expect(resolveCardReference(cards, 'F404')).toBeNull();
  });
});
