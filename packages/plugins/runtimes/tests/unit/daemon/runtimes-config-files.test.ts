/**
 * The model-in-effect adapter: what it refuses when a change is PROPOSED (a stand-in, a part no file of Runtimes holds, a
 * component another plugin owns), that every load carries its OWN stand-ins (no list shared between reads), and the check
 * a setup or a clone makes before it writes.
 */
import type { ModelCatalogSourcesView } from '@ferretry/plugin-logins/contract';
import { memoryPins, modelSourcesOf, TEST_MODEL_SOURCES, TEST_STARTERS } from '../../support/starters.ts';
import { describe, expect, it } from 'bun:test';
import { sampleLogin } from '@ferretry/plugin-logins/contract/testing';
import type { ConfigCollectionDef, ConfigFileDef } from '@ferretry/kernel/contract';
import type { EnvironmentLoginTemplate } from '@ferretry/plugin-logins/contract';
import {
  refuseBeforeWriting,
  runtimesConfigFiles,
  type StarterPins,
} from '../../../daemon/adapters/runtimes-config-files.ts';
import type { ComponentSourceLookup } from '../../../daemon/adapters/profile-components.ts';
import { KIT_OWNERS } from '../../support/real-kits.ts';
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
  components: ComponentSourceLookup = KIT_OWNERS,
  modelSources: () => Promise<ModelCatalogSourcesView> = async () => TEST_MODEL_SOURCES,
  pins: StarterPins = memoryPins(),
) {
  return runtimesConfigFiles({
    pins,
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
      pins: memoryPins(),
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

  describe('D4: a derived runtime keeps the model it first started with', () => {
    // The login has no runtime file of its own, so it is derived.
    const DERIVED: Values = { ...BASE, runtimes: {} };
    const MOVED = { claude: 'claude-moved-default', codex: TEST_STARTERS.codex };
    const KEY = 'claude:claude-you';
    const defaultOf = (loaded: Parameters<typeof modelOf>[0], name: string) => {
      const model = modelOf(loaded);
      const profile = model.runtimes[name]?.profile ?? '';
      const layer = model.profiles[profile]?.layers.find(
        entry => entry.startsWith('modelSets/') || entry.includes('modelSets'),
      );
      return layer === undefined ? undefined : model.components.modelSets[layer.split('/').pop() ?? '']?.default;
    };

    /** The adapter over files, logins and catalogs that can each be swapped between reads. */
    const world = (initial: Values = DERIVED) => {
      const state = {
        values: initial,
        logins: [sampleLogin('claude-you', { store: 'ferretry' })],
        templates: [] as EnvironmentLoginTemplate[],
        sources: TEST_MODEL_SOURCES as ModelCatalogSourcesView,
        pins: memoryPins(),
      };
      const files = runtimesConfigFiles({
        pins: state.pins,
        config: {
          collection: (def: ConfigCollectionDef<unknown>) =>
            new Map(Object.entries(state.values[(def as unknown as { collection: string }).collection] ?? {})),
          file: () => undefined,
        } as never,
        logins: {
          list: async () => ({ format: 1 as const, machine: 'm', logins: state.logins }),
          environmentTemplates: async () => state.templates,
          modelSources: async () => state.sources,
        },
        components: KIT_OWNERS,
        within: work => work,
      });
      return { state, files };
    };

    /** A catalog (`glm` by default) offering these models for Claude Code, the first being its default. */
    const providerSources = (...offered: string[]): ModelCatalogSourcesView => sourcesOffering('glm', ...offered);
    const sourcesOffering = (catalog: string, ...offered: string[]): ModelCatalogSourcesView =>
      ({
        catalogs: {
          ...(TEST_MODEL_SOURCES.catalogs as object),
          [catalog]: {
            label: catalog,
            docs: 'https://example.test/glm',
            claude: {
              models: offered.map((id, index) => ({
                id,
                label: id,
                tier: 'best',
                context: 200000,
                efforts: ['low'],
                defaultEffort: 'low',
                ...(index === 0 ? { default: true } : {}),
              })),
            },
          },
        },
        presets: [{ id: 'glm', catalog: 'glm', variables: {} }],
      }) as unknown as ModelCatalogSourcesView;
    const glmLogin = sampleLogin('glm', { store: 'environment' });
    const glmTemplate = {
      kind: 'templates',
      id: 'glm',
      harness: 'claude-code',
      preset: 'glm',
      env: { ANTHROPIC_AUTH_TOKEN: '${secret:GLM_KEY}' },
    } as never;

    it('records the model of the (login, harness) the first time it sees it', async () => {
      const { state, files } = world();

      await files.load();

      expect(state.pins.file.box.value).toEqual({ models: { [KEY]: TEST_STARTERS.claude } });
    });

    it('leaves the runtime on its first model when the catalog default moves, and offers the new one to a NEW login', async () => {
      const { state, files } = world();
      expect(defaultOf(await files.load(), 'claude-you')).toBe(TEST_STARTERS.claude);

      state.sources = modelSourcesOf(MOVED as Required<typeof MOVED>);
      const after = await files.load();

      // The existing runtime did not move, though the catalog now names another default.
      expect(defaultOf(after, 'claude-you')).toBe(TEST_STARTERS.claude);
      expect(state.pins.file.box.value).toEqual({ models: { [KEY]: TEST_STARTERS.claude } });
      // The built-in profile follows the catalog, so a runtime seen for the first time starts on the new default.
      expect(modelOf(after).components.modelSets['ferretry-claude']?.default).toBe(MOVED.claude);
    });

    it('gives a login seen only after the move the new default, and pins it there', async () => {
      const { state, files } = world();
      await files.load();
      state.sources = modelSourcesOf(MOVED as Required<typeof MOVED>);
      state.logins = [...state.logins, sampleLogin('claude-new', { store: 'ferretry' })];

      const loaded = await files.load();

      expect(defaultOf(loaded, 'claude-you')).toBe(TEST_STARTERS.claude);
      expect(defaultOf(loaded, 'claude-new')).toBe(MOVED.claude);
      expect(state.pins.file.box.value).toEqual({
        models: { [KEY]: TEST_STARTERS.claude, 'claude:claude-new': MOVED.claude },
      });
    });

    it('pins a provider login to the PROVIDER’s default and does not move it when the provider’s default moves', async () => {
      const { state, files } = world();
      state.logins = [glmLogin];
      state.templates = [glmTemplate];
      state.sources = providerSources('provider-old', 'provider-new');
      expect(defaultOf(await files.load(), 'glm')).toBe('provider-old');

      // The provider's default is now the other model, and the old one is still offered.
      state.sources = providerSources('provider-new', 'provider-old');
      const after = await files.load();

      expect(defaultOf(after, 'glm')).toBe('provider-old');
      expect(modelOf(after).runtimes.glm?.refused).toBeUndefined();
      expect(state.pins.file.box.value).toEqual({ models: { 'claude:glm': 'provider-old' } });
    });

    it('REFUSES a provider login whose pinned model is no longer offered, and says what to do', async () => {
      const { state, files } = world();
      state.logins = [glmLogin];
      state.templates = [glmTemplate];
      state.sources = providerSources('provider-old', 'provider-new');
      await files.load();

      state.sources = providerSources('provider-new');
      const after = await files.load();

      expect(modelOf(after).runtimes.glm?.refused).toBe(
        'provider-old is no longer offered for glm; pick a model or use Update now',
      );
      // It is still on its pin: nothing fell back to the live default, and the pin is still the old model.
      expect(defaultOf(after, 'glm')).toBe('provider-old');
      expect(state.pins.file.box.value).toEqual({ models: { 'claude:glm': 'provider-old' } });
    });

    it('treats a MISSING pin file as the first run: nothing is refused and the pin is written', async () => {
      const { state, files } = world();
      state.pins.file.box.value = undefined;

      const loaded = await files.load();

      expect(modelOf(loaded).runtimes['claude-you']?.refused).toBeUndefined();
      expect(state.pins.file.box.value as unknown).toEqual({ models: { [KEY]: TEST_STARTERS.claude } });
    });

    it('fails closed on a pin file that exists and cannot be read: refuses derived runtimes and never rewrites it', async () => {
      const { state, files } = world();
      state.pins = memoryPins({ [KEY]: 'claude-old-pin' }, true);
      const adapted = runtimesConfigFiles({
        pins: state.pins,
        config: {
          collection: (def: ConfigCollectionDef<unknown>) =>
            new Map(Object.entries(state.values[(def as unknown as { collection: string }).collection] ?? {})),
          file: () => undefined,
        } as never,
        logins: {
          list: async () => ({ format: 1 as const, machine: 'm', logins: state.logins }),
          environmentTemplates: async () => [],
          modelSources: async () => TEST_MODEL_SOURCES,
        },
        components: () => 'unavailable',
        within: work => work,
      });
      void files;

      const loaded = await adapted.load();

      expect(modelOf(loaded).runtimes['claude-you']?.refused).toBe('model pins unreadable: starter-pins.json');
      expect(state.pins.file.writes).toEqual([]);
      expect(state.pins.file.box.value).toEqual({ models: { [KEY]: 'claude-old-pin' } });
    });

    it('prunes a removed login’s pins, so a login that later takes its id (after the default moved) gets the CURRENT default', async () => {
      const { state, files } = world();
      await files.load();
      expect(state.pins.file.box.value).toEqual({ models: { [KEY]: TEST_STARTERS.claude } });

      // The login is removed and the evaluation that sees it gone prunes its pin: no timer, no later write needed.
      state.logins = [];
      await files.load();
      expect(state.pins.file.box.value).toEqual({ models: {} });

      // The catalog default moves, and a NEW login arrives with the same id.
      state.sources = modelSourcesOf(MOVED as Required<typeof MOVED>);
      state.logins = [sampleLogin('claude-you', { store: 'ferretry' })];
      const loaded = await files.load();

      expect(defaultOf(loaded, 'claude-you')).toBe(MOVED.claude);
      expect(state.pins.file.box.value).toEqual({ models: { [KEY]: MOVED.claude } });
    });

    it('never gives a new login B the pin of another login A', async () => {
      const { state, files } = world();
      await files.load();
      state.sources = modelSourcesOf(MOVED as Required<typeof MOVED>);
      state.logins = [...state.logins, sampleLogin('claude-b', { store: 'ferretry' })];

      const loaded = await files.load();

      expect(defaultOf(loaded, 'claude-b')).toBe(MOVED.claude);
      expect(defaultOf(loaded, 'claude-you')).toBe(TEST_STARTERS.claude);
    });

    describe('an explicit save of a derived runtime writes the pinned model, never a generated profile', () => {
      /** The edits written into the files, as the kernel's writer applies a patch. */
      const apply = (values: Values, edits: readonly { path: string; patch?: Record<string, unknown> }[]): Values => {
        const next: Values = Object.fromEntries(Object.entries(values).map(([key, map]) => [key, { ...map }]));
        for (const edit of edits) {
          const [folder, file] = edit.path.split('/');
          if (folder === undefined || file === undefined || edit.patch === undefined) continue;
          const name = file.replace(/\.yaml$/u, '');
          next[folder] = {
            ...next[folder],
            [name]: { ...(next[folder]?.[name] ?? {}), ...edit.patch },
          } as Values[string];
        }
        return next;
      };

      it('reloads on the pinned model after the default moved (the saved file has a real profile and model set)', async () => {
        const { state, files } = world();
        const first = await files.load();
        // The catalog's default moves, and the model the runtime started with is still offered.
        state.sources = sourcesOffering('anthropic', MOVED.claude, TEST_STARTERS.claude);
        const loaded = await files.load();
        const before = modelOf(loaded);
        // The owner renames the derived runtime: a new file is written from the model.
        const { 'claude-you': runtime, ...others } = before.runtimes;
        const next = { ...before, runtimes: { ...others, mine: runtime } } as AccountModel;

        const edits = files.editsFor(loaded, next, NO_MOVES) as { path: string; patch?: Record<string, unknown> }[];

        const written = edits.find(edit => edit.path === 'runtimes/mine.yaml')?.patch as {
          login: string;
          profile: string;
        };
        // A whole file, on a profile that names the pinned model, and that profile and its model set are written too.
        expect(written).toEqual({ login: 'claude-you', profile: written.profile });
        expect(written.profile).not.toBe('ferretry-claude');
        expect(edits.find(edit => edit.path === `model-sets/${written.profile}.yaml`)?.patch).toEqual({
          models: [TEST_STARTERS.claude],
          default: TEST_STARTERS.claude,
        });
        expect(edits.find(edit => edit.path === `profiles/${written.profile}.yaml`)?.patch).toEqual({
          contents: expect.arrayContaining([`modelSets/${written.profile}`]),
        });
        // Reloaded from those files (with nothing derived beside them), it is still on the pinned model.
        state.values = apply(DERIVED, edits);
        state.logins = [sampleLogin('claude-you', { store: 'ferretry' })];
        const reloaded = await files.load();
        expect(defaultOf(reloaded, 'mine')).toBe(TEST_STARTERS.claude);
        expect(defaultOf(first, 'claude-you')).toBe(TEST_STARTERS.claude);
      });

      it('refuses to save a derived runtime whose pinned model is gone, saying why and that nothing was changed', async () => {
        const { state, files } = world();
        state.logins = [glmLogin];
        state.templates = [glmTemplate];
        state.sources = providerSources('provider-old', 'provider-new');
        await files.load();
        state.sources = providerSources('provider-new');
        const loaded = await files.load();
        const before = modelOf(loaded);
        const { glm: runtime, ...others } = before.runtimes;
        const next = { ...before, runtimes: { ...others, mine: runtime } } as AccountModel;

        expect(() => files.editsFor(loaded, next, NO_MOVES)).toThrow(
          /provider-old is no longer offered for glm.*nothing was changed/su,
        );
      });
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
