/**
 * Codex's answer to Runtimes' profile component sources: its `settings` and `hooks` items, projected live as the harness
 * they are for and the parsed document.
 */
import { describe, expect, it } from 'bun:test';
import type { HooksItem, SettingsItem } from '../../contract/index.ts';
import { codexHooksSource, codexSettingsSource } from '../../daemon/lib/profile-components.ts';
import { codexRuntimesKit } from '../../daemon/lib/runtimes-kit/index.ts';

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

  it('projects an item’s launch flags beside its document, a copy, and none when it has none', async () => {
    const held = new Map<string, SettingsItem>([
      ['fast', { settings: {}, flags: ['--search', '-c', 'a=1'] }],
      ['plain', { settings: { model: 'm' }, flags: [] }],
      ['bare', { settings: { model: 'm' } }],
    ]);
    const source = codexSettingsSource(() => held);

    const fast = await source.read('fast');
    expect(fast).toEqual({ harness: 'codex', document: {}, flags: ['--search', '-c', 'a=1'] });
    (fast as { flags: string[] }).flags.push('--mutated');
    expect(held.get('fast')?.flags).toEqual(['--search', '-c', 'a=1']);
    expect(await source.read('plain')).toEqual({ harness: 'codex', document: { model: 'm' } });
    expect(await source.read('bare')).toEqual({ harness: 'codex', document: { model: 'm' } });
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

describe('the Codex runtimes kit', () => {
  it('is offered through the settings source, empty, and not through the hooks source', () => {
    const source = codexSettingsSource(() => new Map());
    expect(source.kit).toBe(codexRuntimesKit);
    expect(Object.keys(codexRuntimesKit)).toEqual([]);
    expect(codexHooksSource(() => new Map()).kit).toBeUndefined();
  });
});
