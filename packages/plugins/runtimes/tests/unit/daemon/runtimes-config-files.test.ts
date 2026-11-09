/**
 * The model-in-effect adapter: what it refuses when a change is PROPOSED (a stand-in, a part no file of Runtimes holds, a
 * component another plugin owns), that it answers "unread" before anything was read (fail closed), and the two guards
 * an apply stands behind (the check before a write, the provisioner that will not forward an apply).
 */
import { describe, expect, it } from 'bun:test';
import { sampleLogin } from '@ferretry/plugin-logins/contract/testing';
import type { ConfigCollectionDef, ConfigFileDef } from '@ferretry/kernel/contract';
import {
  refuseBeforeWriting,
  refuseWhileUnreadable,
  runtimesConfigFiles,
} from '../../../daemon/adapters/runtimes-config-files.ts';
import type { AccountModel } from '../../../daemon/lib/account/schema.ts';

type Values = Record<string, Record<string, unknown>>;

const BASE: Values = {
  runtimes: { 'claude-default': { login: 'claude-you', profile: 'default', agent: true } },
  profiles: { default: { contents: ['modelSets/heavy'] } },
  'model-sets': { heavy: { models: ['claude-opus-5-5'], default: 'claude-opus-5-5' } },
};

/** The adapter over in-memory files; `values` can be swapped between reads, as the live config is. */
function adapter(values: { current: Values } = { current: BASE }) {
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
    },
  });
}

const NO_MOVES = new Map<string, string>();

const modelOf = (loaded: { evaluation: { effective: { model: AccountModel } } }) => loaded.evaluation.effective.model;

describe('the model-in-effect adapter', () => {
  it('m3 answers "unread" before anything was read, so nothing is applied from nothing', () => {
    expect(adapter().unreadable()).not.toEqual([]);
  });

  it('reads nothing as standing in when every part was read', async () => {
    const files = adapter();

    await files.load();

    expect(files.unreadable()).toEqual([]);
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

  it('refuses a change that edits a component another plugin owns (instructions here), before a file is written', async () => {
    const files = adapter();
    const loaded = await files.load();
    const before = modelOf(loaded);
    const next = {
      ...before,
      components: { ...before.components, instructions: { rules: { file: 'rules.md' } } },
    } as AccountModel;

    expect(() => files.editsFor(loaded, next, NO_MOVES)).toThrow(
      /instructions "rules".*another part of Ferretry owns/su,
    );
  });
});

describe('the two guards an apply stands behind', () => {
  it('C2 the check before a write refuses while a part stands in and passes when none does', async () => {
    const values = { current: BASE };
    const files = adapter(values);
    const preflight = refuseBeforeWriting(files);

    await files.load();
    await expect(preflight()).resolves.toBeUndefined();

    values.current = { ...BASE, profiles: { default: { contents: ['modelSets/heavy', 'skills/tidy'] } } };
    await expect(preflight()).rejects.toThrow(/nothing was changed.*tidy/su);
  });

  it('R2 the provisioner forwards a preview but never an apply while a part stands in', async () => {
    const calls: string[] = [];
    const inner = {
      preview: async () => {
        calls.push('preview');
        return {} as never;
      },
      apply: async () => {
        calls.push('apply');
        return {} as never;
      },
    };
    let standing: readonly string[] = ['the mcp component "github" belongs to another part of Ferretry'];
    const guarded = refuseWhileUnreadable(inner, { unreadable: () => standing });

    await guarded.preview({} as never);
    await expect(guarded.apply({} as never, [])).rejects.toThrow(/nothing was changed.*github/su);
    standing = [];
    await guarded.apply({} as never, []);

    expect(calls).toEqual(['preview', 'apply']);
  });
});
