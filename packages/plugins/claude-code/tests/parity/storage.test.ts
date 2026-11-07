import { describe, expect, test } from 'bun:test';
import manifest from '../../manifest.ts';
import { CLAUDE_CODE_HOOKS, CLAUDE_CODE_SETTINGS } from '../../contract/index.ts';

/** The configuration families today kept under `config/components/<kind>/{name}.yaml`, now this plugin's collections. */
const collection = (def: unknown) => def as { collection?: string; file?: string; name: RegExp };

describe('storage parity', () => {
  test('F-0156 hooks items are a config collection of this plugin, one yaml file per name', () => {
    expect(manifest.data?.config?.map(def => collection(def).collection ?? collection(def).file)).toContain('claude-code/hooks');
    expect(collection(CLAUDE_CODE_HOOKS).collection).toBe('claude-code/hooks');
    expect(collection(CLAUDE_CODE_HOOKS).name.test('my-hooks')).toBe(true);
    expect(collection(CLAUDE_CODE_HOOKS).name.test('../escape')).toBe(false);
  });

  test('F-0160 settings items are a config collection of this plugin, one yaml file per name', () => {
    expect(manifest.data?.config?.map(def => collection(def).collection ?? collection(def).file)).toContain('claude-code/settings');
    expect(collection(CLAUDE_CODE_SETTINGS).collection).toBe('claude-code/settings');
    expect(collection(CLAUDE_CODE_SETTINGS).name.test('quiet-mode')).toBe(true);
    expect(collection(CLAUDE_CODE_SETTINGS).name.test('Has Space')).toBe(false);
  });
});
