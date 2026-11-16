/**
 * Claude Code's answer to Runtimes' profile component sources: its `settings` and `hooks` items, projected live as the
 * harness they are for and the parsed document. No file text, and a secret stays a reference.
 */
import { describe, expect, it } from 'bun:test';
import type { HooksItem, SettingsItem } from '../../contract/index.ts';
import { claudeHooksSource, claudeSettingsSource } from '../../daemon/lib/profile-components.ts';

describe('the Claude Code settings source', () => {
  it('projects an item as the harness and its document, in name order, live', async () => {
    const held = new Map<string, SettingsItem>([
      ['strict', { description: 'ignored', settings: { permissions: { defaultMode: 'plan' } } }],
      ['api', { settings: { env: { KEY: '${secret:API_KEY}' } } }],
    ]);
    const source = claudeSettingsSource(() => held);

    expect(await source.list()).toEqual(['api', 'strict']);
    expect(await source.read('strict')).toEqual({
      harness: 'claude-code',
      document: { permissions: { defaultMode: 'plan' } },
    });
    expect(JSON.stringify(await source.read('api'))).toContain('${secret:API_KEY}');
    held.delete('strict');
    expect(await source.read('strict')).toBeUndefined();
  });

  it('projects an item’s launch flags beside its document, a copy, and none when it has none', async () => {
    const held = new Map<string, SettingsItem>([
      ['fast', { settings: {}, flags: ['--verbose', '--model', 'x'] }],
      ['plain', { settings: { theme: 'dark' }, flags: [] }],
      ['bare', { settings: { theme: 'dark' } }],
    ]);
    const source = claudeSettingsSource(() => held);

    const fast = await source.read('fast');
    expect(fast).toEqual({ harness: 'claude-code', document: {}, flags: ['--verbose', '--model', 'x'] });
    (fast as { flags: string[] }).flags.push('--mutated');
    expect(held.get('fast')?.flags).toEqual(['--verbose', '--model', 'x']);
    expect(await source.read('plain')).toEqual({ harness: 'claude-code', document: { theme: 'dark' } });
    expect(await source.read('bare')).toEqual({ harness: 'claude-code', document: { theme: 'dark' } });
  });
});

describe('the Claude Code hooks source', () => {
  it('projects an item as the harness and a hooks block', async () => {
    const held = new Map<string, HooksItem>([['guard', { hooks: { PreToolUse: [{ matcher: 'Bash' }] } }]]);
    const source = claudeHooksSource(() => held);

    expect(await source.list()).toEqual(['guard']);
    expect(await source.read('guard')).toEqual({
      harness: 'claude-code',
      document: { hooks: { PreToolUse: [{ matcher: 'Bash' }] } },
    });
    expect(await source.read('absent')).toBeUndefined();
  });
});
