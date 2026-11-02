import { describe, expect, test } from 'bun:test';
import { NO_BOARD_FILTERS } from '../../src/lib/board-model.ts';
import { projectCards, resolveCardReference, sessionCards } from '../../src/lib/session-cards.ts';
import { boardModelOf, card, laptop, originCard, phone, unasked } from './board-support.ts';

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

  test('marks a card the human did not raise, unless it waits on them', async () => {
    const model = await boardModelOf(
      unasked([
        card('F1', { owner: SESSION, createdBy: { kind: 'owner' } }),
        card('F2', { owner: SESSION }),
        card('F3', { owner: SESSION, createdBy: { kind: 'daemon' } }),
      ]),
    );

    const byId = new Map(sessionCards(model, laptop.daemonId, SESSION).map(entry => [entry.id, entry]));

    expect(byId.get('F1')?.agentAsked).toBe(false);
    expect(byId.get('F2')?.agentAsked).toBe(true);
    expect(byId.get('F3')?.agentAsked).toBe(true);
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

describe('projectCards', () => {
  test('keeps every card on this machine, whoever owns it', async () => {
    const model = await boardModelOf([
      card('F1', { owner: SESSION }),
      card('F2', { owner: 'someone-else', assignee: 'another' }),
      card('F3', { owner: 'someone-else' }),
    ]);

    expect(
      projectCards(model, laptop.daemonId, SESSION)
        .map(entry => entry.id)
        .sort(),
    ).toEqual(['F1', 'F2', 'F3']);
    expect(projectCards(model, phone.daemonId, SESSION)).toEqual([]);
  });

  test('reads askedBy before origin, and origin when that is all the daemon sends', async () => {
    const model = await boardModelOf(
      [
        card('F1', { owner: SESSION, askedBy: 'agent' }),
        Object.assign(card('F2', { owner: SESSION }), { askedBy: undefined, origin: 'agent' }),
      ],
      { ...NO_BOARD_FILTERS, agents: true },
    );

    const byId = new Map(projectCards(model, laptop.daemonId, SESSION).map(entry => [entry.id, entry]));

    expect(byId.get('F1')?.agentAsked).toBe(true);
    expect(byId.get('F2')?.agentAsked).toBe(true);
  });

  test('asks the daemon who a card was for, and only guesses for a daemon that does not say', async () => {
    const model = await boardModelOf(
      [
        originCard('F1', 'human', null, { owner: SESSION }),
        originCard('F2', 'agent', { id: 'F1' }, { owner: SESSION, createdBy: { kind: 'owner' } }),
        ...unasked([card('F3', { owner: SESSION }), card('F4', { owner: SESSION, createdBy: { kind: 'owner' } })]),
      ],
      { ...NO_BOARD_FILTERS, agents: true },
    );

    const byId = new Map(projectCards(model, laptop.daemonId, SESSION).map(entry => [entry.id, entry]));

    expect(byId.get('F1')?.agentAsked).toBe(false);
    expect(byId.get('F2')?.agentAsked).toBe(true);
    expect(byId.get('F3')?.agentAsked).toBe(true);
    expect(byId.get('F4')?.agentAsked).toBe(false);
  });
});
