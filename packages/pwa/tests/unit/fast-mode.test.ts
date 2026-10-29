import { describe, expect, test } from 'bun:test';
import type { SessionView } from '@ferretry/protocol';
import {
  FAST_COST_NOTE_KEY,
  fastCostNoteSeen,
  fastModeInForce,
  fastModeUnsupportedReason,
  markFastCostNoteSeen,
} from '../../src/lib/fast-mode.ts';
import type { RuntimeModelCatalog } from '../../src/lib/runtime-models.ts';
import '../support/dom.ts';
import { sessionView } from '../support/sessions.ts';

const view = (config: Partial<SessionView['config']> = {}, state: Partial<SessionView['state']> = {}): SessionView =>
  sessionView('s-1', { config, state });

const catalog = (fast: boolean | undefined): RuntimeModelCatalog => ({
  harness: 'claude',
  source: 'wrapper-inventory',
  choices: [
    { value: 'claude-opus-5-5', label: 'Opus 5.5', reasoningEfforts: [], ...(fast === undefined ? {} : { fast }) },
    { value: 'claude-haiku-5-5[1m]', label: 'Haiku 5.5', reasoningEfforts: [], fast: false },
  ],
});

describe('fastModeInForce with the catalog entry of the model', () => {
  const sol: RuntimeModelCatalog = {
    harness: 'codex',
    source: 'codex-app-server',
    choices: [
      { value: 'gpt-6-sol', label: 'GPT-6-Sol', reasoningEfforts: [], fast: true, fastDefault: true },
      { value: 'gpt-daybreak', label: 'Daybreak Blue', reasoningEfforts: [], fast: false },
    ],
  };

  test('should fall back to what the model does by default when nothing was reported or launched', () => {
    expect(fastModeInForce(view({ model: 'gpt-6-sol' }), sol)).toBeTrue();
    expect(fastModeInForce(view({ model: 'gpt-6-sol' }, { observedFast: false }), sol)).toBeFalse();
    expect(fastModeInForce(view({ model: 'gpt-6-sol', launchFast: false }), sol)).toBeFalse();
  });

  test('should follow the model the harness reported, not the one launched', () => {
    expect(fastModeInForce(view({ model: 'gpt-daybreak' }, { observedModel: 'gpt-6-sol' }), sol)).toBeTrue();
  });

  test('should never be on for a model the catalog says has none, whatever the login saved', () => {
    expect(fastModeInForce(view({ model: 'gpt-daybreak', launchFast: true }), sol)).toBeFalse();
    expect(fastModeInForce(view({ model: 'gpt-daybreak' }, { observedFast: true }), sol)).toBeFalse();
  });

  test('should be off when the catalog does not know the model or is not read', () => {
    expect(fastModeInForce(view({ model: 'unknown' }), sol)).toBeFalse();
    expect(fastModeInForce(view({ model: 'gpt-6-sol' }))).toBeFalse();
    expect(fastModeInForce(view())).toBeFalse();
  });
});

describe('fastModeInForce', () => {
  test('should prefer what the harness reported over what the session was launched with', () => {
    expect(fastModeInForce(view({ launchFast: true }, { observedFast: false }))).toBeFalse();
    expect(fastModeInForce(view({ launchFast: false }, { observedFast: true }))).toBeTrue();
  });

  test('should fall back to the launch, then to off', () => {
    expect(fastModeInForce(view({ launchFast: true }))).toBeTrue();
    expect(fastModeInForce(view())).toBeFalse();
  });
});

describe('fastModeUnsupportedReason', () => {
  test('should disable only on an explicit no', () => {
    expect(fastModeUnsupportedReason(catalog(false), 'claude-opus-5-5')).toBe('Opus 5.5 has no fast mode.');
    expect(fastModeUnsupportedReason(catalog(true), 'claude-opus-5-5')).toBeUndefined();
    expect(fastModeUnsupportedReason(catalog(undefined), 'claude-opus-5-5')).toBeUndefined();
  });

  test('should not guess without a catalog, a model, or a matching choice', () => {
    expect(fastModeUnsupportedReason(null, 'claude-opus-5-5')).toBeUndefined();
    expect(fastModeUnsupportedReason(catalog(false), undefined)).toBeUndefined();
    expect(fastModeUnsupportedReason(catalog(false), 'something-else')).toBeUndefined();
  });

  test('should match a model the harness reports without its context-window selector', () => {
    expect(fastModeUnsupportedReason(catalog(false), 'claude-haiku-5-5')).toBe('Haiku 5.5 has no fast mode.');
  });
});

describe('the fast cost note', () => {
  const memory = () => {
    const values = new Map<string, string>();
    return {
      values,
      storage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => void values.set(key, value),
      },
    };
  };

  test('should be unseen until it is marked, then seen under the one key', () => {
    const { storage, values } = memory();

    expect(fastCostNoteSeen(storage)).toBeFalse();
    markFastCostNoteSeen(storage);

    expect(fastCostNoteSeen(storage)).toBeTrue();
    expect([...values.keys()]).toEqual([FAST_COST_NOTE_KEY]);
  });

  test('should treat a storage that throws as unseen and never throw', () => {
    const refusing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };

    expect(fastCostNoteSeen(refusing)).toBeFalse();
    expect(() => markFastCostNoteSeen(refusing)).not.toThrow();
  });

  test('should treat an absent storage as unseen and mark nothing', () => {
    expect(fastCostNoteSeen(undefined)).toBeFalse();
    expect(() => markFastCostNoteSeen(undefined)).not.toThrow();
  });

  test('should read the browser storage when none is passed', () => {
    const before = globalThis.localStorage?.getItem(FAST_COST_NOTE_KEY) ?? null;
    globalThis.localStorage?.removeItem(FAST_COST_NOTE_KEY);
    try {
      expect(fastCostNoteSeen()).toBeFalse();
      markFastCostNoteSeen();
      expect(fastCostNoteSeen()).toBeTrue();
    } finally {
      if (before === null) globalThis.localStorage?.removeItem(FAST_COST_NOTE_KEY);
      else globalThis.localStorage?.setItem(FAST_COST_NOTE_KEY, before);
    }
  });
});

describe('a browser whose storage accessor itself throws', () => {
  test('should read as unseen and never throw', () => {
    // Arrange — a private window or blocked site data can make the accessor throw, not just the calls.
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('denied');
      },
    });
    try {
      // Act / Assert
      expect(fastCostNoteSeen()).toBeFalse();
      expect(() => markFastCostNoteSeen()).not.toThrow();
    } finally {
      if (original === undefined) Reflect.deleteProperty(globalThis, 'localStorage');
      else Object.defineProperty(globalThis, 'localStorage', original);
    }
  });
});

describe('a browser whose storage is absent or not a store', () => {
  test('should read as unseen and never throw', () => {
    // Arrange
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const under = (value: unknown, check: () => void): void => {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value });
      check();
    };
    try {
      // Act / Assert
      for (const value of [undefined, {}, { getItem: () => '1' }, { getItem: () => '1', setItem: 'no' }])
        under(value, () => {
          expect(fastCostNoteSeen()).toBeFalse();
          expect(() => markFastCostNoteSeen()).not.toThrow();
        });
    } finally {
      if (original === undefined) Reflect.deleteProperty(globalThis, 'localStorage');
      else Object.defineProperty(globalThis, 'localStorage', original);
    }
  });
});
