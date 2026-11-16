import { describe, expect, test } from 'bun:test';
import { patchedValue } from '../../../host/config/patch.ts';

/** The one patch rule the real writer and the testing host share: `within` merges a named mapping one level deep. */
describe('patchedValue without within: a patch of top-level keys, exactly as before (golden)', () => {
  const current = { enabled: true, caps: { daily: 5, price: 2 }, guard: { level: 'high' }, list: [1, 2] };

  test('a key is set, an `undefined` key is removed, every other key stays, and a mapping is REPLACED whole', () => {
    expect(patchedValue(current, { enabled: false, guard: undefined, caps: { daily: 3 } })).toEqual({
      enabled: false,
      caps: { daily: 3 },
      list: [1, 2],
    });
  });

  test('it is the old spread-then-delete, key order included, for every shape of patch', () => {
    const old = (patch: Record<string, unknown>) => {
      const target: Record<string, unknown> = { ...current, ...patch };
      for (const [key, value] of Object.entries(patch)) if (value === undefined) delete target[key];
      return target;
    };
    const patches: Record<string, unknown>[] = [
      {},
      { enabled: false },
      { caps: { daily: 1, price: undefined } },
      { added: 1, enabled: undefined, missing: undefined },
      { list: [3], caps: null, guard: 'flat' },
    ];
    for (const patch of patches) {
      const next = patchedValue(current, patch);
      expect(next).toEqual(old(patch));
      expect(Object.keys(next)).toEqual(Object.keys(old(patch)));
      // the `undefined` sub-key of a replaced mapping is passed on as written, as before
      expect(JSON.stringify(next)).toBe(JSON.stringify(old(patch)));
    }
  });

  test('an empty `within` is no `within`', () => {
    expect(patchedValue(current, { caps: { daily: 3 } }, [])).toEqual({ ...current, caps: { daily: 3 } });
  });
});

describe('patchedValue with within: a named top-level mapping merges ONE level deep', () => {
  const current = {
    enabled: true,
    caps: { daily: 5, price: 0.042, hourly: { share: 0.5, floor: 1 } },
    guard: { level: 'high', notes: ['a'] },
  };

  test('a named sub-key is replaced, a new one is added, and every sub-key the patch does not name is kept', () => {
    expect(patchedValue(current, { caps: { daily: 3, weekly: 20 } }, ['caps'])).toEqual({
      enabled: true,
      caps: { daily: 3, price: 0.042, hourly: { share: 0.5, floor: 1 }, weekly: 20 },
      guard: { level: 'high', notes: ['a'] },
    });
  });

  test('an `undefined` sub-key removes that sub-key and nothing else', () => {
    const next = patchedValue(current, { caps: { price: undefined } }, ['caps']);
    expect(next.caps).toEqual({ daily: 5, hourly: { share: 0.5, floor: 1 } });
    expect(Object.hasOwn(next.caps as object, 'price')).toBe(false);
    // every sub-key removed leaves an empty mapping, not a removed key
    expect(patchedValue({ caps: { a: 1 } }, { caps: { a: undefined } }, ['caps'])).toEqual({ caps: {} });
  });

  test('one level only: a sub-key that is itself a mapping (or a list) is replaced whole, never merged further', () => {
    const next = patchedValue(current, { caps: { hourly: { share: 0.1 } }, guard: { notes: ['b'] } }, [
      'caps',
      'guard',
    ]);
    expect(next.caps).toEqual({ daily: 5, price: 0.042, hourly: { share: 0.1 } });
    expect(next.guard).toEqual({ level: 'high', notes: ['b'] });
  });

  test('only the NAMED keys merge: an unnamed mapping in the same patch is replaced whole', () => {
    const next = patchedValue(current, { caps: { daily: 1 }, guard: { level: 'low' } }, ['caps']);
    expect(next.caps).toEqual({ daily: 1, price: 0.042, hourly: { share: 0.5, floor: 1 } });
    expect(next.guard).toEqual({ level: 'low' });
  });

  test('a named key the patch does not name is untouched, and a named key set to `undefined` is removed', () => {
    expect(patchedValue(current, { enabled: false }, ['caps', 'guard'])).toEqual({ ...current, enabled: false });
    expect(patchedValue(current, { caps: undefined }, ['caps'])).toEqual({ enabled: true, guard: current.guard });
  });

  test('a new value that is not a mapping (a scalar, a list, null) replaces the named key as a plain patch does', () => {
    for (const value of [7, 'flat', [1, 2], null, true]) {
      expect(patchedValue(current, { caps: value }, ['caps'])).toEqual(patchedValue(current, { caps: value }));
      expect(patchedValue(current, { caps: value }, ['caps']).caps).toEqual(value);
    }
  });

  test('a current value that is not a mapping (absent, a scalar, a list, null) is replaced by the new mapping', () => {
    for (const existing of [undefined, 4, 'flat', [1], null]) {
      const start = existing === undefined ? {} : { caps: existing };
      expect(patchedValue(start, { caps: { daily: 2, price: undefined } }, ['caps']).caps).toEqual({ daily: 2 });
    }
  });

  test('a merge extends the FILE’s own mapping (base), never the schema-parsed one: no default is written by a merge', () => {
    // parsed = what the schema made of the file (defaults filled in); file = what the file itself holds
    const parsed = { enabled: true, caps: { daily: 10, price: 2 } };
    const file = { enabled: true };
    const merged = patchedValue(parsed, { caps: { daily: 3 } }, ['caps'], file);
    expect(merged.caps).toEqual({ daily: 3 });
    // the same section the plain patch writes
    expect(merged.caps).toEqual(patchedValue(parsed, { caps: { daily: 3 } }).caps);
    // a section the file has keeps its own sub-keys, and only those
    expect(patchedValue(parsed, { caps: { weekly: 9 } }, ['caps'], { caps: { daily: 5 } }).caps).toEqual({
      daily: 5,
      weekly: 9,
    });
  });

  test('a `within` that is not a list names nothing: a string is never read as its letters', () => {
    // 'ab' would name the keys `a` and `b` if it were spread into a set of its characters
    const asString = 'ab' as unknown as readonly string[];
    const start = { a: { keep: 1 }, b: { keep: 2 }, ab: { keep: 3 } };
    const patch = { a: { added: 1 }, b: { added: 2 }, ab: { added: 3 } };
    expect(patchedValue(start, patch, asString)).toEqual(patchedValue(start, patch));
    expect(patchedValue(start, patch, asString)).toEqual(patch);
  });

  test('neither input is changed', () => {
    const before = structuredClone(current);
    const patch = { caps: { daily: 1, price: undefined } };
    patchedValue(current, patch, ['caps']);
    expect(current).toEqual(before);
    expect(patch).toEqual({ caps: { daily: 1, price: undefined } });
  });

  test('a key spelled __proto__ is an ordinary key: it never reaches a prototype, at either level', () => {
    const patch = JSON.parse('{"__proto__": {"polluted": 1}, "caps": {"__proto__": {"polluted": 2}}}') as Record<
      string,
      unknown
    >;
    const next = patchedValue(current, patch, ['__proto__', 'caps']);
    expect(Object.getPrototypeOf(next)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(next.caps)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.hasOwn(next, '__proto__')).toBe(true);
    expect(Object.hasOwn(next.caps as object, '__proto__')).toBe(true);
    // the merged own `__proto__` key holds exactly the patch’s mapping
    expect(Object.getOwnPropertyDescriptor(next, '__proto__')?.value).toEqual({ polluted: 1 });
  });
});
