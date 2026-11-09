/**
 * The model-in-effect adapter: what it refuses when a change is PROPOSED (a stand-in, a part no file of Runtimes holds, a
 * component another plugin owns), that every load carries its OWN stand-ins (no list shared between reads), and the check
 * a setup or a clone makes before it writes.
 */
import { describe, expect, it } from 'bun:test';
import { sampleLogin } from '@ferretry/plugin-logins/contract/testing';
import type { ConfigCollectionDef, ConfigFileDef } from '@ferretry/kernel/contract';
import { refuseBeforeWriting, runtimesConfigFiles } from '../../../daemon/adapters/runtimes-config-files.ts';
import type { ComponentSourceLookup } from '../../../daemon/adapters/profile-components.ts';
import type { AccountModel } from '../../../daemon/lib/account/schema.ts';

type Values = Record<string, Record<string, unknown>>;

/** Every owner answers, with nothing: a kind is read and empty. */
const EMPTY_OWNERS: ComponentSourceLookup = () => ({ list: async () => [], read: async () => undefined });

const BASE: Values = {
  runtimes: { 'claude-default': { login: 'claude-you', profile: 'default', agent: true } },
  profiles: { default: { contents: ['modelSets/heavy'] } },
  'model-sets': { heavy: { models: ['claude-opus-5-5'], default: 'claude-opus-5-5' } },
};

/** The adapter over in-memory files; `values` can be swapped between reads, as the live config is. */
function adapter(
  values: { current: Values } = { current: BASE },
  components: ComponentSourceLookup = () => 'unavailable',
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
    },
    components,
  });
}

const NO_MOVES = new Map<string, string>();

const modelOf = (loaded: { evaluation: { effective: { model: AccountModel } } }) => loaded.evaluation.effective.model;

describe('the model-in-effect adapter', () => {
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
        { ...before, machine: { ...before.machine, agentPermissions: 'skip' } } as AccountModel,
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
