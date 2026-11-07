import { describe, expect, test } from 'bun:test';
import manifest from '../../manifest.ts';

describe('agenda manifest', () => {
  test('declares only the owner-facing routes; item routes are Asks’ and push routes are Access’', () => {
    const keys = manifest.actions.routes.map(route => route.key);
    expect(keys).toHaveLength(7);
    expect(keys.some(key => key.includes('/push'))).toBe(false);
    expect(keys.some(key => /\/agenda(\/|$)/.test(key) && key.includes(':ferret/agenda'))).toBe(false);
  });
  test('the owner-only routes refuse a ferret', () => {
    for (const route of manifest.actions.routes)
      if (route.path.startsWith('/v1/machine') || route.path.startsWith('/v1/agenda'))
        expect(route.caller).toBe('person');
  });
  test('state files start at format 1 and the words are agenda and buzz', () => {
    expect(manifest.data.state.map(file => [file.path, file.format])).toEqual([
      ['seen.json', 1],
      ['buzzes.jsonl', 1],
    ]);
    expect(manifest.words.map(word => word.word)).toEqual(['agenda', 'buzz']);
  });
});
