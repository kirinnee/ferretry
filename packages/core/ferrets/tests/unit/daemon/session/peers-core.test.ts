import { describe, expect, test } from 'bun:test';
import { type CoreAccount, canServeModel, declaredModel } from '../../../../daemon/lib/session/peers/core.ts';

/** An account that serves two models, one of them marked down, the way the published manifest row says. */
const account = (more: { available?: boolean } = {}): CoreAccount =>
  ({
    id: 'work',
    agent: 'claude-work',
    kind: 'claude',
    mode: 'interactive',
    wrapper: '/wrappers/claude-work',
    home: '/homes/work',
    displayName: 'Work',
    defaultModel: 'claude-opus-5-5',
    available: more.available ?? true,
    models: [
      { id: 'claude-opus-5-5', available: true, context: 200_000 },
      { id: 'claude-sonnet-5-5', available: false, unavailableReason: 'not in this plan' },
    ],
  }) as unknown as CoreAccount;

describe('the catalog entry a model id names', () => {
  test('is the entry with that id exactly', () => {
    expect(declaredModel(account(), 'claude-opus-5-5')?.context).toBe(200_000);
  });

  test('is the entry the bare id names when the session records it with a [1m]-style selector', () => {
    expect(declaredModel(account(), 'claude-opus-5-5[1m]')?.id).toBe('claude-opus-5-5');
  });

  test('is nothing for a model the catalog does not list, with or without a selector', () => {
    expect(declaredModel(account(), 'claude-haiku-5-5')).toBeUndefined();
    expect(declaredModel(account(), 'claude-haiku-5-5[1m]')).toBeUndefined();
  });
});

describe('whether an account can serve a model', () => {
  test('it can serve an available model, named bare or with its selector', () => {
    expect(canServeModel(account(), 'claude-opus-5-5')).toBe(true);
    expect(canServeModel(account(), 'claude-opus-5-5[1m]')).toBe(true);
  });

  test('it cannot serve a model marked unavailable, one it does not list, or anything while it is itself down', () => {
    expect(canServeModel(account(), 'claude-sonnet-5-5')).toBe(false);
    expect(canServeModel(account(), 'claude-haiku-5-5')).toBe(false);
    expect(canServeModel(account({ available: false }), 'claude-opus-5-5')).toBe(false);
  });
});
