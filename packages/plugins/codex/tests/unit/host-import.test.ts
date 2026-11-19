/**
 * The setup import's write of a Codex settings component (`ProfileComponentSource.put`): what is written, what is never
 * written, and that a taken name is never replaced.
 */
import { describe, expect, it } from 'bun:test';
import type { ConfigCollectionDef, ConfigEdit, ConfigWriteOutcome } from '@ferretry/kernel/contract';
import { CODEX_SETTINGS, type SettingsItem } from '../../contract/index.ts';
import { codexSettingsPut, type HostImportConfig } from '../../daemon/features/host-import/index.ts';
import { settingsItemsFromImport } from '../../daemon/features/host-import/settings-item.ts';

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
    etag: async (_def, name) => (name !== undefined && written.has(name) ? `etag-${name}` : 'absent'),
    writeAsCaller: async (_def: unknown, name: string | undefined, edit: ConfigEdit, option) => {
      options.push(option);
      if (answer !== undefined) return answer;
      if (name === undefined || typeof edit !== 'string') throw new Error('a whole item text is written');
      if (option?.ifMatch === 'absent' && written.has(name)) return { kind: 'conflict' };
      if (option?.ifMatch !== undefined && option.ifMatch !== 'absent' && option.ifMatch !== `etag-${name}`)
        return { kind: 'conflict' };
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

  it('replaces its own item for an update the person accepted, pinned to the current etag', async () => {
    const { config, written, options } = tree({ mine: { settings: { model: 'old' } } });

    const result = await codexSettingsPut(config)(
      'mine',
      asText({ harness: 'codex', document: { model: 'new' } }),
      undefined,
      { replace: true },
    );

    expect(result).toEqual({ ok: true });
    expect(written.get('mine')).toEqual({ settings: { model: 'new' } });
    expect(options).toEqual([{ ifMatch: 'etag-mine' }]);
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

const CANARY = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH';

describe('what a Codex settings item never takes from an import', () => {
  it('never writes a root profile key, which breaks every launch, and says so', async () => {
    const { config, written } = tree();

    const result = await codexSettingsPut(config)(
      'imported',
      asText({ harness: 'codex', document: { model: 'm', profile: 'work' } }),
    );

    expect(result).toEqual({
      ok: true,
      warnings: ['Not imported: profile selects a host profile that is not here; each chosen profile is its own item'],
    });
    const item = written.get('imported');
    expect(item?.settings).not.toHaveProperty('profile');
    expect(item?.settings.model).toBe('m');
  });

  const COMMAND_KEYS: readonly [string, Record<string, unknown>, string][] = [
    ['hooks', { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] } }, 'hooks'],
    ['notify', { notify: ['notify-send', 'done'] }, 'notify'],
    ['mcp_servers', { mcp_servers: { s: { command: 'npx', args: ['x'], http_headers_helper: 'h' } } }, 'mcp_servers'],
    ['plugins', { plugins: { p: { enabled: true } } }, 'plugins'],
    ['marketplaces', { marketplaces: { m: { source: 'git' } } }, 'marketplaces'],
    [
      'model_providers.*.auth',
      { model_providers: { corp: { name: 'Corp', auth: { command: 'print-token', args: ['--x'], timeout_ms: 1 } } } },
      'model_providers.corp.auth',
    ],
    [
      'gateway_oauth.credential_export',
      {
        model_providers: {
          corp: { name: 'Corp', gateway_oauth: { credential_export: { command: 'tok' }, scope: 's' } },
        },
      },
      'model_providers.corp.gateway_oauth.credential_export',
    ],
    [
      'desktop.custom_file_handlers',
      { desktop: { custom_file_handlers: { ed: { command: 'ed' } }, theme: 'dark' } },
      'desktop.custom_file_handlers',
    ],
  ];

  for (const [label, extra, path] of COMMAND_KEYS) {
    it(`never writes ${label}: it returns as a "Not imported: … runs a command" warning, without its value`, () => {
      const made = settingsItemsFromImport('x', asText({ harness: 'codex', document: { model: 'm', ...extra } }));

      expect(made.ok).toBe(true);
      if (!made.ok) return;
      expect(made.warnings.some(sentence => sentence.startsWith(`Not imported: ${path} `))).toBe(true);
      const written = JSON.stringify(made.items);
      for (const held of ['print-token', 'notify-send', 'npx', 'tok"', '"ed"', 'git'])
        expect(written).not.toContain(held);
      expect(made.items[0]?.item.settings.model).toBe('m');
    });
  }

  it('keeps what is next to a dropped provider command (the rest of the provider)', () => {
    const made = settingsItemsFromImport(
      'x',
      asText({
        harness: 'codex',
        document: {
          model_providers: { corp: { name: 'Corp', base_url: 'https://corp.invalid', auth: { command: 'c' } } },
        },
      }),
    );

    expect(made).toEqual({
      ok: true,
      items: [
        {
          name: 'x',
          item: { settings: { model_providers: { corp: { name: 'Corp', base_url: 'https://corp.invalid' } } } },
        },
      ],
      warnings: ['Not imported: model_providers.corp.auth runs a command'],
    });
  });

  it('drops the component’s env with a sentence', () => {
    const made = settingsItemsFromImport(
      'x',
      asText({ harness: 'codex', document: { model: 'm' }, env: { OPENAI_BASE_URL: 'https://example.invalid' } }),
    );

    expect(made).toEqual({
      ok: true,
      items: [{ name: 'x', item: { settings: { model: 'm' } } }],
      warnings: ['Not imported: env is moved to the login instead'],
    });
  });

  it('refuses a ${secret:} reference anywhere in the settings, naming the key and never a value', () => {
    const made = settingsItemsFromImport(
      'x',
      asText({ harness: 'codex', document: { mcp_servers_note: { s: { env: { KEY: '${secret:S_KEY}' } } } } }),
    );

    expect(made.ok).toBe(false);
    expect(JSON.stringify(made)).toContain('mcp_servers_note.s.env.KEY');
    expect(JSON.stringify(made)).not.toContain('S_KEY');
  });

  it('refuses a document that is not for Codex or not readable', () => {
    expect(settingsItemsFromImport('x', asText({ harness: 'claude', document: {} })).ok).toBe(false);
    expect(settingsItemsFromImport('x', 'not json {').ok).toBe(false);
    expect(settingsItemsFromImport('x', asText([1])).ok).toBe(false);
    expect(settingsItemsFromImport('x', asText({ harness: 'codex', document: {}, flags: [1] })).ok).toBe(false);
  });
});

describe('a credential anywhere in the settings reaches no file (canary)', () => {
  it('leaves out experimental_bearer_token, api keys and token-shaped values, and names only the path', async () => {
    const { config, written } = tree();

    const result = await codexSettingsPut(config)(
      'imported',
      asText({
        harness: 'codex',
        document: {
          model: 'm',
          model_providers: {
            corp: { name: 'Corp', experimental_bearer_token: CANARY, headers: { 'x-api-key': CANARY }, list: [CANARY] },
          },
          api_key: CANARY,
          note: CANARY,
        },
        flags: ['--search', `--api-key=${CANARY}`],
      }),
    );

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain(CANARY);
    expect(JSON.stringify([...written.values()])).not.toContain(CANARY);
    expect(written.get('imported')).toEqual({
      settings: { model: 'm', model_providers: { corp: { name: 'Corp', headers: {}, list: [] } } },
    });
    if (result.ok)
      expect(result.warnings).toEqual([
        'Not imported: model_providers.corp.experimental_bearer_token looks like a secret',
        'Not imported: model_providers.corp.headers.x-api-key looks like a secret',
        'Not imported: model_providers.corp.list[0] looks like a secret',
        'Not imported: api_key looks like a secret',
        'Not imported: note looks like a secret',
        'Not imported: flags look like a secret',
      ]);
  });

  it('keeps a secret out of a profile too (only its model and effort are ever read)', () => {
    const made = settingsItemsFromImport(
      'x',
      asText({
        harness: 'codex',
        document: { profiles: { fast: { model: 'm', api_key: CANARY, approval_policy: 'never' } } },
      }),
    );

    expect(made.ok).toBe(true);
    expect(JSON.stringify(made)).not.toContain(CANARY);
    expect(JSON.stringify(made)).not.toContain('approval_policy');
  });
});

describe('Codex profiles the import chose', () => {
  const profiles = {
    fast: {
      model: 'gpt-x',
      model_reasoning_effort: 'low',
      approval_policy: 'never',
      sandbox_mode: 'danger-full-access',
    },
    deep: { model: 'gpt-y', model_reasoning_effort: 'high' },
  };

  it('each become one settings item holding only the model and its reasoning effort, beside the main item', async () => {
    const { config, written } = tree();

    const result = await codexSettingsPut(config)(
      'host-codex',
      asText({ harness: 'codex', document: { model: 'main', approval_policy: 'on-request', profiles } }),
    );

    expect(result).toEqual({ ok: true });
    expect([...written.keys()].toSorted()).toEqual(['host-codex', 'profile-deep', 'profile-fast']);
    expect(written.get('host-codex')).toEqual({ settings: { model: 'main', approval_policy: 'on-request' } });
    expect(written.get('profile-fast')).toEqual({ settings: { model: 'gpt-x', model_reasoning_effort: 'low' } });
    expect(written.get('profile-deep')).toEqual({ settings: { model: 'gpt-y', model_reasoning_effort: 'high' } });
  });

  it('works when the person skipped codex:settings: the table arrives alone, so there is no main item', async () => {
    const { config, written } = tree();

    const result = await codexSettingsPut(config)('host-codex', asText({ harness: 'codex', document: { profiles } }));

    expect(result).toEqual({ ok: true });
    expect([...written.keys()].toSorted()).toEqual(['profile-deep', 'profile-fast']);
  });

  it('honours codex:profile:<name> skips: a profile the planner left out is not written', async () => {
    const { config, written } = tree();

    await codexSettingsPut(config)(
      'host-codex',
      asText({ harness: 'codex', document: { profiles: { deep: profiles.deep } } }),
    );

    expect([...written.keys()]).toEqual(['profile-deep']);
  });

  it('writes the main item alone when the planner left no profile table (every profile skipped)', async () => {
    const { config, written } = tree();

    await codexSettingsPut(config)('host-codex', asText({ harness: 'codex', document: { model: 'main' } }));

    expect([...written.keys()]).toEqual(['host-codex']);
  });

  it('warns about a profile it cannot make an item of, and about a name taken, while the rest lands', async () => {
    const { config, written } = tree({ 'profile-deep': { settings: { model: 'mine' } } });

    const result = await codexSettingsPut(config)(
      'host-codex',
      asText({
        harness: 'codex',
        document: {
          profiles: {
            fast: profiles.fast,
            deep: profiles.deep,
            plain: { approval_policy: 'never' },
            '!!': { model: 'm' },
          },
        },
      }),
    );

    expect(result).toEqual({
      ok: true,
      warnings: [
        'Not imported: profile "plain" sets neither a model nor a reasoning effort',
        'Not imported: profile "!!" has no name a file can carry',
        'Not imported: a Codex settings item named "profile-deep" already exists',
      ],
    });
    expect(written.get('profile-deep')).toEqual({ settings: { model: 'mine' } });
    expect(written.has('profile-fast')).toBe(true);
  });

  it('refuses when nothing at all can be written', async () => {
    const { config } = tree();

    const result = await codexSettingsPut(config)(
      'host-codex',
      asText({ harness: 'codex', document: { profiles: { plain: { approval_policy: 'never' } } } }),
    );

    expect(result).toEqual({ ok: false, reason: 'nothing in it is imported' });
  });
});

describe('the declared collection', () => {
  it('is the one Codex owns, so the write is judged by its schema and loosening', () => {
    expect((CODEX_SETTINGS as ConfigCollectionDef<SettingsItem>).collection).toBe('codex/settings');
  });
});
