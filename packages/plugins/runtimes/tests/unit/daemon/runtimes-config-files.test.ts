/**
 * The model-in-effect adapter: what it refuses when a change is PROPOSED (a stand-in, a part no file of Runtimes holds, a
 * component another plugin owns), that every load carries its OWN stand-ins (no list shared between reads), and the check
 * a setup or a clone makes before it writes.
 */
import type { ModelCatalogSourcesView } from '@ferretry/plugin-logins/contract';
import { TEST_MODEL_SOURCES, TEST_STARTERS } from '../../support/starters.ts';
import { describe, expect, it } from 'bun:test';
import { sampleLogin } from '@ferretry/plugin-logins/contract/testing';
import type { ConfigCollectionDef, ConfigFileDef } from '@ferretry/kernel/contract';
import type { EnvironmentLoginTemplate } from '@ferretry/plugin-logins/contract';
import { refuseBeforeWriting, runtimesConfigFiles } from '../../../daemon/adapters/runtimes-config-files.ts';
import type { ComponentSourceLookup } from '../../../daemon/adapters/profile-components.ts';
import type { AccountModel } from '../../../daemon/lib/account/schema.ts';

type Values = Record<string, Record<string, unknown>>;

/** Every owner answers, with nothing: a kind is read and empty. */
const EMPTY_OWNERS: ComponentSourceLookup = () => ({ list: async () => [], read: async () => undefined });

const BASE: Values = {
  runtimes: { 'claude-default': { login: 'claude-you', profile: 'default' } },
  profiles: { default: { contents: ['modelSets/heavy'] } },
  'model-sets': { heavy: { models: ['claude-opus-5-5'], default: 'claude-opus-5-5' } },
};

/** The adapter over in-memory files; `values` can be swapped between reads, as the live config is. */
function adapter(
  values: { current: Values } = { current: BASE },
  components: ComponentSourceLookup = () => 'unavailable',
  modelSources: () => Promise<ModelCatalogSourcesView> = async () => TEST_MODEL_SOURCES,
) {
  return runtimesConfigFiles({
    config: {
      collection: (def: ConfigCollectionDef<unknown>) =>
        new Map(Object.entries(values.current[(def as unknown as { collection: string }).collection] ?? {})),
      file: (_def: ConfigFileDef<unknown>) => undefined,
    } as never,
    logins: {
      list: async () => ({
        format: 1 as const,
        machine: 'm',
        logins: [sampleLogin('claude-you', { store: 'ferretry' })],
      }),
      environmentTemplates: async () => [],
      modelSources,
    },
    components,
    within: work => work,
  });
}

const NO_MOVES = new Map<string, string>();

const modelOf = (loaded: { evaluation: { effective: { model: AccountModel } } }) => loaded.evaluation.effective.model;

describe('the model-in-effect adapter', () => {
  it('keeps no copy of the login templates: a template Logins changed shows on the NEXT read (O2)', async () => {
    const glm = sampleLogin('glm', {
      store: 'environment',
      environment: {
        variables: [],
        quotaSource: 'none',
        missingSecrets: [],
        test: { available: false, reason: 'x' },
      } as never,
    });
    const templates: { current: EnvironmentLoginTemplate[] } = {
      current: [{ kind: 'templates', id: 'glm', harness: 'claude-code', env: { REGION: 'eu' } } as never],
    };
    const files = runtimesConfigFiles({
      config: {
        collection: (def: ConfigCollectionDef<unknown>) =>
          new Map(
            Object.entries(
              {
                ...BASE,
                runtimes: { 'glm-work': { login: 'glm', profile: 'default' } },
              }[(def as unknown as { collection: string }).collection] ?? {},
            ),
          ),
        file: () => undefined,
      } as never,
      logins: {
        list: async () => ({ format: 1 as const, machine: 'm', logins: [glm] }),
        environmentTemplates: async () => templates.current,
        modelSources: async () => TEST_MODEL_SOURCES,
      },
      components: () => 'unavailable',
      within: work => work,
    });

    const first = await files.inEffect();
    templates.current = [{ kind: 'templates', id: 'glm', harness: 'claude-code', env: { REGION: 'us' } } as never];
    const second = await files.inEffect();

    expect(modelOf(first).credentials.glm?.env).toEqual({ REGION: 'eu' });
    expect(modelOf(second).credentials.glm?.env).toEqual({ REGION: 'us' });
  });

  it('gives the built-in model set of each harness the default model of the catalog Logins states', async () => {
    const loaded = await adapter().load();

    expect(modelOf(loaded).components.modelSets['ferretry-claude']).toEqual({
      models: [TEST_STARTERS.claude],
      default: TEST_STARTERS.claude,
    });
    expect(modelOf(loaded).components.modelSets['ferretry-codex']).toEqual({
      models: [TEST_STARTERS.codex],
      default: TEST_STARTERS.codex,
    });
  });

  it('still reads the model when Logins cannot state its catalogs: the built-in profiles hold no model set then', async () => {
    const files = adapter(
      { current: BASE },
      () => 'unavailable',
      async () => await Promise.reject(new Error('locked')),
    );

    const loaded = await files.load();

    expect(modelOf(loaded).components.modelSets['ferretry-claude']).toBeUndefined();
    expect(modelOf(loaded).profiles['ferretry-claude']?.layers.join(' ')).not.toContain('modelSets/');
  });

  it('reads nothing as standing in when every part was read', async () => {
    const files = adapter();

    expect((await files.load()).unreadable).toEqual([]);
  });

  it('C1 each load carries its OWN stand-ins: a later read that finds none does not clear an earlier one', async () => {
    const values: { current: Values } = {
      current: { ...BASE, profiles: { default: { contents: ['modelSets/heavy', 'mcp/github'] } } },
    };
    const files = adapter(values);
    const standingIn = await files.load();

    values.current = BASE;
    const clean = await files.load();

    expect(standingIn.unreadable.join(' ')).toContain('github');
    expect(clean.unreadable).toEqual([]);
    // The plan made from the first load still cannot be turned into edits: it answers for itself.
    expect(() => files.editsFor(standingIn, modelOf(standingIn), NO_MOVES)).toThrow(/nothing was changed.*github/su);
  });

  it('C2 refuses a change when it is proposed while a part stands in, naming it and saying nothing was changed', async () => {
    const files = adapter({
      current: { ...BASE, profiles: { default: { contents: ['modelSets/heavy', 'mcp/github'] } } },
    });
    const loaded = await files.load();

    expect(() => files.editsFor(loaded, modelOf(loaded), NO_MOVES)).toThrow(/nothing was changed.*github/su);
  });

  it('C1 refuses a change that sets a machine setting no file of Runtimes holds, and lets default runtime and auto-resume through', async () => {
    const files = adapter();
    const loaded = await files.load();
    const before = modelOf(loaded);

    expect(() =>
      files.editsFor(
        loaded,
        { ...before, machine: { ...before.machine, agentPermissions: 'auto' } } as AccountModel,
        NO_MOVES,
      ),
    ).toThrow(/agentPermissions.*no file of Runtimes holds/su);
    expect(
      files.editsFor(
        loaded,
        { ...before, machine: { ...before.machine, autoResume: false } } as AccountModel,
        NO_MOVES,
      ),
    ).toEqual([{ path: 'runtimes.yaml', patch: { autoResume: false } }]);
  });

  it('C1 writes the two loopback-port settings into runtimes.yaml only off their defaults, and drops them when back on them', async () => {
    const files = adapter();
    const loaded = await files.load();
    const before = modelOf(loaded);
    const moved = {
      ...before,
      machine: { ...before.machine, browserPorts: 'per-user', browserFirewallFailure: 'refuse' },
    };

    expect(files.editsFor(loaded, moved as AccountModel, NO_MOVES)).toEqual([
      { path: 'runtimes.yaml', patch: { browserPorts: 'per-user', browserFirewallFailure: 'refuse' } },
    ]);
  });

  it('refuses a change that edits a component another plugin owns (mcp here), before a file is written', async () => {
    const files = adapter(undefined, EMPTY_OWNERS);
    const loaded = await files.load();
    const before = modelOf(loaded);
    const next = {
      ...before,
      components: { ...before.components, mcp: { github: { command: 'github-mcp' } } },
    } as AccountModel;

    expect(() => files.editsFor(loaded, next, NO_MOVES)).toThrow(/mcp "github".*another part of Ferretry owns/su);
  });
});

describe('the check made before a setup or a clone writes', () => {
  it('C2 the check before a write refuses while a part stands in and passes when none does', async () => {
    const values = { current: BASE };
    const files = adapter(values);
    const preflight = refuseBeforeWriting(files);

    await files.load();
    await expect(preflight()).resolves.toBeUndefined();

    values.current = { ...BASE, profiles: { default: { contents: ['modelSets/heavy', 'skills/tidy'] } } };
    await expect(preflight()).rejects.toThrow(/nothing was changed.*tidy/su);
  });
});
