import { describe, expect, test } from 'bun:test';
import {
  BrowserIdentityKeySchema,
  BrowserProfileKindSchema,
  BrowsersConfigSchema,
  DEFAULT_BROWSER_IDENTITY,
} from '../../contract/index.ts';

describe('the browser identity key', () => {
  test('the built-in identity is agent, and it is a valid key', () => {
    expect(DEFAULT_BROWSER_IDENTITY).toBe('agent');
    expect(BrowserIdentityKeySchema.safeParse(DEFAULT_BROWSER_IDENTITY).success).toBe(true);
  });

  test('a short lowercase name is a key', () => {
    for (const key of ['a', 'work', 'client-2', 'a'.repeat(32)]) {
      expect(BrowserIdentityKeySchema.safeParse(key).success).toBe(true);
    }
  });

  test('a key that could leave the data folder, or is not a plain name, is refused at parse', () => {
    for (const key of [
      'a/b',
      '..',
      '../x',
      'a..b',
      'Work',
      'WORK',
      '-a',
      '1a',
      '',
      'a b',
      'a.b',
      'a\\b',
      'a'.repeat(33),
    ]) {
      expect(BrowserIdentityKeySchema.safeParse(key).success).toBe(false);
    }
  });

  test('browsers.yaml keys its identities by the same grammar', () => {
    expect(BrowsersConfigSchema.safeParse({ identities: { work: {} } }).success).toBe(true);
    expect(BrowsersConfigSchema.safeParse({ identities: { '../work': {} } }).success).toBe(false);
    expect(BrowsersConfigSchema.safeParse({ identities: { Work: {} } }).success).toBe(false);
  });

  test('a profile is only ever the shared kind: a per-session profile is never emitted', () => {
    expect(BrowserProfileKindSchema.options).toEqual(['shared']);
  });
});
