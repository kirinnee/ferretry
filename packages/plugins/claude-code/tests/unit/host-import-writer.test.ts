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
  const said: string[] = [];
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
  return { config, said, put: claudeSettingsPut({ def: DEF, config, say: sentence => said.push(sentence) }) };
}

describe('claudeSettingsPut over the real config writer', () => {
  test('writes the file, says what it kept out (keys only), and never the values', async () => {
    const { config, put, said } = await world(true);
    const answer = await put(
      'imported',
      text({
        harness: 'claude',
        document: { model: 'opus', hooks: { Stop: [] }, apiKeyHelper: '/bin/secret-helper' },
      }),
    );
    expect(answer).toEqual({ ok: true });
    expect(config.collection(DEF).get('imported')).toEqual({ settings: { model: 'opus' } });
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('hooks');
    expect(said[0]).toContain('apiKeyHelper');
    expect(said[0]).not.toContain('secret-helper');
  });

  test('a raw secret in the document is refused, nothing is written, and the answer never repeats it', async () => {
    const { config, put } = await world(true);
    const answer = await put('leaky', text({ harness: 'claude', document: { model: 'opus', token: SECRET } }));
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
