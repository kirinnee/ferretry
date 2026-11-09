/**
 * The account model as Runtimes reads it from its own files and Logins' facts, and the edits that move those files to
 * another model: only the keys that changed, a new file whole, a removed file removed, and a stand-in for what another
 * plugin owns that is never mistaken for a document read.
 */
import { describe, expect, it } from 'bun:test';
import { sampleLogin } from '@ferretry/plugin-logins/contract/testing';
import type { ProfileFile, RuntimeFile } from '../../../contract/index.ts';
import { ownedFileBodies, ownedFileEdits } from '../../../daemon/lib/account/runtimes-edits.ts';
import { assembleRuntimesModel, type RuntimesFiles } from '../../../daemon/lib/account/runtimes-model.ts';

const runtime = (overrides: Partial<RuntimeFile> = {}): RuntimeFile =>
  ({ login: 'claude-you', profile: 'default', agent: false, ...overrides }) as RuntimeFile;

const profile = (contents: readonly string[] = []): ProfileFile => ({ contents: [...contents] }) as ProfileFile;

const files = (overrides: Partial<RuntimesFiles> = {}): RuntimesFiles => ({
  runtimes: new Map([['claude-default', runtime({ agent: true })]]),
  profiles: new Map([['default', profile(['modelSets/heavy'])]]),
  modelSets: new Map([['heavy', { models: ['claude-opus-5-5'], default: 'claude-opus-5-5' }]]),
  settings: undefined,
  logins: [sampleLogin('claude-you', { store: 'ferretry' })],
  ...overrides,
});

describe('the model Runtimes assembles from its own files', () => {
  it('holds the runtime, its profile, its model set and its login, and says nothing stands in for a document', () => {
    const assembled = assembleRuntimesModel(files());

    expect(Object.keys(assembled.model.runtimes)).toEqual(['claude-default']);
    expect(assembled.model.runtimes['claude-default']).toMatchObject({
      credential: 'claude-you',
      profile: 'default',
      agent: true,
    });
    expect(assembled.model.profiles.default?.layers).toEqual(['modelSets/heavy']);
    expect(assembled.model.components.modelSets.heavy?.default).toBe('claude-opus-5-5');
    expect(assembled.model.credentials['claude-you']).toMatchObject({ harness: 'claude', store: 'ferretry' });
    expect(assembled.unreadable).toEqual([]);
    expect(assembled.sources).toBe(4);
  });

  it('reads runtimes.yaml as the machine default runtime and the auto-resume switch', () => {
    const assembled = assembleRuntimesModel(
      files({ settings: { defaultRuntime: 'claude-default', autoResume: false } }),
    );

    expect(assembled.model.machine.defaultRuntime).toBe('claude-default');
    expect(assembled.model.machine.autoResume).toBe(false);
  });

  it('keeps a layer of a kind another plugin owns in its profile, stands in for its component, and names it', () => {
    const assembled = assembleRuntimesModel(
      files({ profiles: new Map([['default', profile(['modelSets/heavy', 'mcp/github', 'settings/codex-guard'])]]) }),
    );

    expect(assembled.model.profiles.default?.layers).toEqual(['modelSets/heavy', 'mcp/github', 'settings/codex-guard']);
    expect(assembled.unreadable).toEqual([
      'the mcp component "github" belongs to another part of Ferretry, which Runtimes cannot read',
      'the settings component "codex-guard" belongs to another part of Ferretry, which Runtimes cannot read',
    ]);
  });

  it('stands in for an environment login, whose templates Logins does not show, and names it without a value', () => {
    const view = sampleLogin('glm', {
      store: 'environment',
      environment: {
        variables: [
          { name: 'ANTHROPIC_BASE_URL', kind: 'plain', value: 'https://api.example.test' },
          { name: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', secrets: ['GLM_KEY'], set: true },
        ],
        quotaSource: 'none',
        missingSecrets: [],
        test: { available: false, reason: 'no test' },
      } as never,
    });
    const assembled = assembleRuntimesModel(
      files({ logins: [view], runtimes: new Map([['glm', runtime({ login: 'glm' })]]) }),
    );

    expect(assembled.unreadable).toHaveLength(1);
    expect(assembled.unreadable[0]).toContain('login "glm"');
    expect(JSON.stringify(assembled.unreadable)).not.toContain('GLM_KEY');
    // The secret stays a reference, never a value.
    expect(assembled.model.credentials.glm?.env).toEqual({
      ANTHROPIC_BASE_URL: 'https://api.example.test',
      ANTHROPIC_AUTH_TOKEN: '${secret:GLM_KEY}',
    });
  });

  it('refuses files that do not fit together, naming the rule: a runtime on a login that is not there', () => {
    expect(() => assembleRuntimesModel(files({ logins: [] }))).toThrow(/uses unknown credential/u);
  });

  it('gives the same revision for the same files and another for a changed one', () => {
    const first = assembleRuntimesModel(files()).revision;

    expect(assembleRuntimesModel(files()).revision).toBe(first);
    expect(
      assembleRuntimesModel(files({ runtimes: new Map([['claude-default', runtime({ agent: false })]]) })).revision,
    ).not.toBe(first);
  });
});

describe('the edits that move Runtimes’ own files to another model', () => {
  const before = assembleRuntimesModel(files()).model;
  const changed = (next: RuntimesFiles): ReturnType<typeof ownedFileEdits> =>
    ownedFileEdits(before, assembleRuntimesModel(next).model);

  it('is empty when nothing changed', () => {
    expect(ownedFileEdits(before, before)).toEqual([]);
  });

  it('patches ONLY the key that changed, so a comment or any other key in the file is never touched', () => {
    const edits = changed(
      files({ runtimes: new Map([['claude-default', runtime({ agent: true, compactAt: 'auto' })]]) }),
    );

    expect(edits).toEqual([{ path: 'runtimes/claude-default.yaml', patch: { compactAt: 'auto' } }]);
  });

  it('removes a key the next model no longer has, with an undefined patch value', () => {
    const withShell = assembleRuntimesModel(
      files({ runtimes: new Map([['claude-default', runtime({ agent: true, shell: 'nix' })]]) }),
    ).model;

    expect(ownedFileEdits(withShell, before)).toEqual([
      { path: 'runtimes/claude-default.yaml', patch: { shell: undefined } },
    ]);
  });

  it('writes a new runtime, profile and model set whole, with the harness spelled as the plugin key', () => {
    const edits = changed(
      files({
        runtimes: new Map([
          ['claude-default', runtime({ agent: true })],
          ['codex-work', runtime({ login: 'codex-you', harness: 'codex', profile: 'extra' })],
        ]),
        profiles: new Map([
          ['default', profile(['modelSets/heavy'])],
          ['extra', profile([])],
        ]),
        logins: [
          sampleLogin('claude-you', { store: 'ferretry' }),
          sampleLogin('codex-you', { harness: 'codex', harnesses: ['codex'], store: 'ferretry' }),
        ],
      }),
    );

    expect(edits).toEqual([
      {
        path: 'runtimes/codex-work.yaml',
        patch: { login: 'codex-you', profile: 'extra', harness: 'codex', agent: false },
      },
      { path: 'profiles/extra.yaml', patch: { contents: [] } },
    ]);
  });

  it('removes the file of a runtime that is gone, and never removes runtimes.yaml', () => {
    const none = assembleRuntimesModel(files({ runtimes: new Map() })).model;

    expect(ownedFileEdits(before, none)).toEqual([{ path: 'runtimes/claude-default.yaml', remove: true }]);
    expect([...ownedFileBodies(none).keys()]).toContain('runtimes.yaml');
  });

  it('carries a rename as a new file written whole and the old one removed', () => {
    const renamed = changed(files({ runtimes: new Map([['claude-main', runtime({ agent: true })]]) }));

    expect(renamed).toEqual([
      { path: 'runtimes/claude-main.yaml', patch: { login: 'claude-you', profile: 'default', agent: true } },
      { path: 'runtimes/claude-default.yaml', remove: true },
    ]);
  });

  it('moves the default runtime and the auto-resume switch through runtimes.yaml', () => {
    const edits = changed(files({ settings: { defaultRuntime: 'claude-default', autoResume: false } }));

    expect(edits).toEqual([{ path: 'runtimes.yaml', patch: { defaultRuntime: 'claude-default', autoResume: false } }]);
  });
});
