/**
 * An accepted update replaces only what an import left. Through the real daemon half and the test host's config service
 * (whose etags follow the file's content as the kernel's do): import a Codex profile, delete it, make the same name by hand,
 * accept the update. The hand-made item stays exactly as it is, and the answer says so.
 */
import { describe, expect, test } from 'bun:test';
import type { ConfigCollectionDef } from '@ferretry/kernel/contract';
import { implementDaemon } from '@ferretry/kernel/manifest';
import { testHost } from '@ferretry/kernel/testing';
import type { ProfileComponentSource } from '@ferretry/plugin-runtimes/contract';
import { CODEX_SETTINGS, type SettingsItem } from '../../contract/index.ts';
import daemon from '../../daemon/index.ts';
import manifest from '../../manifest.ts';

const HOOK = 'runtimes.components.settings.codex:components';
const NOTHING = { exitCode: 1, signal: null, stdout: '', stderr: '' };

async function world() {
  let source: ProfileComponentSource | undefined;
  let config: ConfigWriter | undefined;
  const spy = implementDaemon(manifest, {
    build(ctx) {
      const half = daemon.build?.(ctx);
      if (half === undefined) throw new Error('the Codex half did not build');
      source = (half.hooks as Record<string, unknown>)[HOOK] as ProfileComponentSource;
      config = ctx.kernel.config as ConfigWriter;
      return half;
    },
  });
  const host = await testHost({ plugins: [spy], spawn: async () => NOTHING });
  return {
    host,
    put: source?.put?.bind(source) as NonNullable<ProfileComponentSource['put']>,
    config: config as ConfigWriter,
  };
}

interface ConfigWriter {
  collection(def: ConfigCollectionDef<SettingsItem>): ReadonlyMap<string, SettingsItem>;
  remove(def: ConfigCollectionDef<SettingsItem>, name: string): Promise<unknown>;
  write(def: ConfigCollectionDef<SettingsItem>, name: string, text: string): Promise<unknown>;
}

const document = (model: string): string =>
  `${JSON.stringify({ harness: 'codex', document: { model: 'main', profiles: { review: { model } } } }, null, 2)}\n`;

describe('an accepted update of an imported Codex settings component', () => {
  test('leaves a profile the person deleted and made again by hand under the same name as it is', async () => {
    const { put, config } = await world();
    const made = await put('mine', document('imported'));
    if (!made.ok) throw new Error('the first import was refused');
    expect(Object.keys(made.etags ?? {}).toSorted()).toEqual(['mine', 'profile-review']);

    await config.remove(CODEX_SETTINGS as ConfigCollectionDef<SettingsItem>, 'profile-review');
    await config.write(
      CODEX_SETTINGS as ConfigCollectionDef<SettingsItem>,
      'profile-review',
      `${JSON.stringify({ settings: { model: 'by-hand' } }, null, 2)}\n`,
    );
    const answer = await put('mine', document('host-now'), undefined, {
      replace: true,
      owned: made.created ?? [],
      etags: made.etags ?? {},
    });

    const items = config.collection(CODEX_SETTINGS as ConfigCollectionDef<SettingsItem>);
    expect(items.get('profile-review')).toEqual({ settings: { model: 'by-hand' } });
    expect(answer).toMatchObject({
      ok: true,
      warnings: [expect.stringContaining('profile-review already exists')],
    });
  });

  test('replaces a profile nobody touched since the import', async () => {
    const { put, config } = await world();
    const made = await put('mine', document('imported'));
    if (!made.ok) throw new Error('the first import was refused');

    const answer = await put('mine', document('host-now'), undefined, {
      replace: true,
      owned: made.created ?? [],
      etags: made.etags ?? {},
    });

    const items = config.collection(CODEX_SETTINGS as ConfigCollectionDef<SettingsItem>);
    expect(answer.ok).toBe(true);
    expect(items.get('profile-review')).toEqual({ settings: { model: 'host-now' } });
  });
});
