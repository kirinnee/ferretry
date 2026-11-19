/**
 * A6: Claude Code's settings `put` over the kernel's REAL config writer (memory disk, no network): the refusal of a raw
 * secret, the hold on a loosening and the create-only rule are the kernel's and this plugin's own, not a stand-in's.
 */
import { describe, expect, test } from 'bun:test';
import { createConfigFiles } from '../../../../core/kernel/host/config/service.ts';
import { createMemoryHostFs } from '../../../../core/kernel/host/state/memory-fs.ts';
import type { ConfigCollectionDef } from '@ferretry/kernel/contract';
import { CLAUDE_CODE_SETTINGS, type SettingsItem } from '../../contract/index.ts';
import { claudeSettingsPut } from '../../daemon/features/host-import/put.ts';

const DEF = CLAUDE_CODE_SETTINGS as ConfigCollectionDef<SettingsItem>;
const text = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const SECRET = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH';

async function world(judge: boolean) {
  const files = createConfigFiles({
    home: '/home/fy',
    fs: createMemoryHostFs(),
    clock: { nowMs: () => 1_000_000, after: () => () => undefined, every: () => () => undefined },
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined } as never,
    binary: 'fy',
    defs: [{ plugin: 'claude-code', def: DEF }],
    judge: () => judge,
  });
  await files.reload();
  const config = files.port('claude-code');
  return { config, put: claudeSettingsPut({ def: DEF, config }) };
}

describe('claudeSettingsPut over the real config writer', () => {
  test('an update the person accepted replaces the item; a first import never does', async () => {
    const { config, put } = await world(true);
    await put('mine', text({ harness: 'claude', document: { model: 'opus' } }));

    const refused = await put('mine', text({ harness: 'claude', document: { model: 'sonnet' } }));
    const replaced = await put('mine', text({ harness: 'claude', document: { model: 'sonnet' } }), undefined, {
      replace: true,
    });

    expect(refused.ok).toBe(false);
    expect(replaced).toEqual({ ok: true });
    expect(config.collection(DEF).get('mine')).toEqual({ settings: { model: 'sonnet' } });
  });

  test('writes the file, warns what it kept out (keys only), and never the values', async () => {
    const { config, put } = await world(true);
    const answer = await put(
      'imported',
      text({
        harness: 'claude',
        document: { model: 'opus', hooks: { Stop: [] }, apiKeyHelper: '/bin/secret-helper' },
      }),
    );
    expect(config.collection(DEF).get('imported')).toEqual({ settings: { model: 'opus' } });
    if (!answer.ok) throw new Error('refused');
    const said = (answer.warnings ?? []).join(' ');
    expect(answer.warnings).toHaveLength(2);
    expect(said).toContain('hooks');
    expect(said).toContain('apiKeyHelper');
    expect(said).not.toContain('secret-helper');
  });

  test('a secret anywhere in the document (canary) reaches no file; the answer names its path, never the value', async () => {
    const { config, put } = await world(true);
    const answer = await put(
      'leaky',
      text({
        harness: 'claude',
        document: {
          model: 'opus',
          token: SECRET,
          proxy: { apiKey: SECRET, bearerToken: SECRET, url: 'https://example.invalid' },
          list: [SECRET, 'fine'],
        },
        flags: ['--verbose', '--api-key', SECRET],
      }),
    );
    if (!answer.ok) throw new Error('refused');
    expect(JSON.stringify(answer)).not.toContain(SECRET);
    expect(answer.warnings).toEqual([
      'Not imported: token looks like a secret',
      'Not imported: proxy.apiKey looks like a secret',
      'Not imported: proxy.bearerToken looks like a secret',
      'Not imported: list[0] looks like a secret',
      'Not imported: flags look like a secret',
    ]);
    const item = config.collection(DEF).get('leaky');
    expect(item).toEqual({
      settings: { model: 'opus', proxy: { url: 'https://example.invalid' }, list: ['fine'] },
    });
    expect(JSON.stringify(item)).not.toContain(SECRET);
  });

  test('a document that is only a secret is refused and nothing is written', async () => {
    const { config, put } = await world(true);
    const answer = await put('only', text({ harness: 'claude', document: { token: SECRET } }));
    expect(answer.ok).toBe(false);
    expect(JSON.stringify(answer)).not.toContain(SECRET);
    expect(config.collection(DEF).size).toBe(0);
  });

  test('a launch flag that loosens the permission mode is held for the owner, not put into effect', async () => {
    const { config, put } = await world(false);
    const answer = await put(
      'loose',
      text({ harness: 'claude', document: { model: 'opus' }, flags: ['--dangerously-skip-permissions'] }),
    );
    expect(answer).toEqual({ ok: true, held: true });
    expect(config.collection(DEF).has('loose')).toBe(false);
  });

  test('never replaces an item that is there', async () => {
    const { config, put } = await world(true);
    expect(await put('one', text({ harness: 'claude', document: { model: 'a' } }))).toEqual({ ok: true });
    const again = await put('one', text({ harness: 'claude', document: { model: 'b' } }));
    expect(again.ok).toBe(false);
    expect(config.collection(DEF).get('one')).toEqual({ settings: { model: 'a' } });
  });
});
