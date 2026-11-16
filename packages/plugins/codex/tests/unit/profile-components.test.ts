/**
 * Codex's answer to Runtimes' profile component sources: its `settings` and `hooks` items, projected live as the harness
 * they are for and the parsed document.
 */
import { describe, expect, it } from 'bun:test';
import type { HooksItem, SettingsItem } from '../../contract/index.ts';
import { codexHooksSource, codexSettingsSource } from '../../daemon/lib/profile-components.ts';

describe('the Codex settings source', () => {
  it('projects an item as the harness and its document, live', async () => {
    const held = new Map<string, SettingsItem>([
      ['guard', { settings: { shell_environment_policy: { inherit: 'core' } } }],
    ]);
    const source = codexSettingsSource(() => held);

    expect(await source.list()).toEqual(['guard']);
    expect(await source.read('guard')).toEqual({
      harness: 'codex',
      document: { shell_environment_policy: { inherit: 'core' } },
    });
    held.clear();
    expect(await source.read('guard')).toBeUndefined();
  });
});

describe('the Codex hooks source', () => {
  it('projects an item as the harness and a hooks block (rendered as hooks.json by Runtimes)', async () => {
    const held = new Map<string, HooksItem>([['notify', { hooks: { Stop: [{ hooks: [{ type: 'command' }] }] } }]]);
    const source = codexHooksSource(() => held);

    expect(await source.list()).toEqual(['notify']);
    expect(await source.read('notify')).toEqual({
      harness: 'codex',
      document: { hooks: { Stop: [{ hooks: [{ type: 'command' }] }] } },
    });
    expect(await source.read('absent')).toBeUndefined();
  });
});
