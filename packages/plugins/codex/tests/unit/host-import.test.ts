/**
 * The setup import's write of a Codex settings component (`ProfileComponentSource.put`): what is written, what is never
 * written, and that a taken name is never replaced.
 */
import { describe, expect, it } from 'bun:test';
import type { ConfigCollectionDef, ConfigEdit, ConfigWriteOutcome } from '@ferretry/kernel/contract';
import { CODEX_SETTINGS, type SettingsItem } from '../../contract/index.ts';
import { codexSettingsPut, type HostImportConfig } from '../../daemon/features/host-import/index.ts';
import { settingsItemFromImport } from '../../daemon/features/host-import/settings-item.ts';

const asText = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** A config tree over Codex's settings collection that stores what the kernel would accept and answers its outcomes. */
function tree(
  existing: Record<string, SettingsItem> = {},
  answer?: ConfigWriteOutcome,
): { config: HostImportConfig; written: Map<string, SettingsItem>; options: unknown[] } {
  const written = new Map(Object.entries(existing));
  const options: unknown[] = [];
  const config: HostImportConfig = {
    collection: () => written as never,
    writeAsCaller: async (_def: unknown, name: string | undefined, edit: ConfigEdit, option) => {
      options.push(option);
      if (answer !== undefined) return answer;
      if (name === undefined || typeof edit !== 'string') throw new Error('a whole item text is written');
      if (written.has(name)) return { kind: 'conflict' };
      written.set(name, Bun.YAML.parse(edit) as SettingsItem);
      return { kind: 'written', etag: 'e1', loosened: [] };
    },
  };
  return { config, written, options };
}

describe('a Codex settings component the import hands over', () => {
  it('lands as a settings item, create only', async () => {
    const { config, written, options } = tree();
    const put = codexSettingsPut(config);

    const result = await put(
      'host-codex',
      asText({ harness: 'codex', document: { model: 'gpt-x', sandbox_mode: 'read-only' }, flags: ['--search'] }),
    );

    expect(result).toEqual({ ok: true });
    expect(written.get('host-codex')).toEqual({
      settings: { model: 'gpt-x', sandbox_mode: 'read-only' },
      flags: ['--search'],
    });
    expect(options).toEqual([{ ifMatch: 'absent' }]);
  });

  it('never replaces an item that already has the name', async () => {
    const { config, written } = tree({ mine: { settings: { model: 'keep' } } });

    const result = await codexSettingsPut(config)('mine', asText({ harness: 'codex', document: { model: 'other' } }));

    expect(result).toEqual({ ok: false, reason: 'a Codex settings item named "mine" already exists' });
    expect(written.get('mine')).toEqual({ settings: { model: 'keep' } });
  });

  it('reports a name taken between the look and the write as taken', async () => {
    const { config } = tree({}, { kind: 'conflict' });

    const result = await codexSettingsPut(config)('late', asText({ harness: 'codex', document: {} }));

    expect(result).toEqual({ ok: false, reason: 'a Codex settings item named "late" already exists' });
  });

  it('reports a write the kernel holds as held, and a refusal in a sentence without a value', async () => {
    const held = tree({}, { kind: 'held', etag: 'e', id: 'h1', sentences: ['agents now run unsandboxed'] });
    expect(await codexSettingsPut(held.config)('a', asText({ harness: 'codex', document: {} }))).toEqual({
      ok: true,
      held: true,
    });

    const refused = tree(
      {},
      { kind: 'refused', reason: 'raw_secret', issues: [{ path: 'settings.token', message: 'looks like a secret' }] },
    );
    const result = await codexSettingsPut(refused.config)('b', asText({ harness: 'codex', document: {} }));
    expect(result).toEqual({
      ok: false,
      reason: 'Codex did not accept the settings (raw secret: looks like a secret)',
    });
  });
});

describe('what a Codex settings item never takes from an import', () => {
  it('never writes a root profile key, which breaks every launch', async () => {
    const { config, written } = tree();

    const result = await codexSettingsPut(config)(
      'imported',
      asText({ harness: 'codex', document: { model: 'm', profile: 'work', profiles: { work: { model: 'x' } } } }),
    );

    expect(result).toEqual({ ok: true });
    const item = written.get('imported');
    expect(item?.settings).not.toHaveProperty('profile');
    expect(item?.settings.model).toBe('m');
  });

  it('never writes hooks or notify (a command run on events), and drops the component’s env', () => {
    const made = settingsItemFromImport(
      asText({
        harness: 'codex',
        document: {
          model: 'm',
          hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] },
          notify: ['notify-send', 'done'],
        },
        env: { OPENAI_BASE_URL: 'https://example.invalid' },
      }),
    );

    expect(made).toEqual({ ok: true, item: { settings: { model: 'm' } } });
  });

  it('refuses a ${secret:} reference anywhere in the settings, naming the key and never a value', () => {
    const made = settingsItemFromImport(
      asText({ harness: 'codex', document: { mcp_servers: { s: { env: { KEY: '${secret:S_KEY}' } } } } }),
    );

    expect(made.ok).toBe(false);
    expect(JSON.stringify(made)).toContain('mcp_servers.s.env.KEY');
    expect(JSON.stringify(made)).not.toContain('S_KEY');
  });

  it('refuses a document that is not for Codex or not readable', () => {
    expect(settingsItemFromImport(asText({ harness: 'claude', document: {} })).ok).toBe(false);
    expect(settingsItemFromImport('not json {').ok).toBe(false);
    expect(settingsItemFromImport(asText([1])).ok).toBe(false);
    expect(settingsItemFromImport(asText({ harness: 'codex', document: {}, flags: [1] })).ok).toBe(false);
  });
});

describe('Codex profiles the import chose', () => {
  it('each become one settings item holding only the model and its reasoning effort', async () => {
    const { config, written } = tree();
    const put = codexSettingsPut(config);

    expect(
      await put(
        'profile-fast',
        asText({ harness: 'codex', document: { model: 'gpt-x', model_reasoning_effort: 'low' } }),
      ),
    ).toEqual({ ok: true });
    expect(
      await put(
        'profile-deep',
        asText({ harness: 'codex', document: { model: 'gpt-y', model_reasoning_effort: 'high' } }),
      ),
    ).toEqual({ ok: true });

    expect([...written.keys()].toSorted()).toEqual(['profile-deep', 'profile-fast']);
    expect(written.get('profile-fast')).toEqual({ settings: { model: 'gpt-x', model_reasoning_effort: 'low' } });
    expect(written.get('profile-deep')).toEqual({ settings: { model: 'gpt-y', model_reasoning_effort: 'high' } });
  });
});

describe('the declared collection', () => {
  it('is the one Codex owns, so the write is judged by its schema and loosening', () => {
    expect((CODEX_SETTINGS as ConfigCollectionDef<SettingsItem>).collection).toBe('codex/settings');
  });
});
