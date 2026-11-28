/**
 * The account model as Runtimes reads it from its own files and Logins' facts, and the edits that move those files to
 * another model: only the keys that changed, a new file whole, a removed file removed, and a stand-in for what another
 * plugin owns that is never mistaken for a document read.
 */
import { describe, expect, it } from 'bun:test';
import { sampleLogin } from '@ferretry/plugin-logins/contract/testing';
import type { ProfileFile, RuntimeFile } from '../../../contract/index.ts';
import { ownedFileBodies, ownedFileEdits, unownedChanges } from '../../../daemon/lib/account/runtimes-edits.ts';
import {
  assembleRuntimesModel,
  NO_COMPONENTS,
  type RuntimesFiles,
  standInsNamedBy,
  stoodInLoginSentence,
} from '../../../daemon/lib/account/runtimes-model.ts';

const runtime = (overrides: Partial<RuntimeFile> = {}): RuntimeFile =>
  ({ login: 'claude-you', profile: 'default', ...overrides }) as RuntimeFile;

const profile = (contents: readonly string[] = []): ProfileFile => ({ contents: [...contents] }) as ProfileFile;

const files = (overrides: Partial<RuntimesFiles> = {}): RuntimesFiles => ({
  runtimes: new Map([['claude-default', runtime({})]]),
  profiles: new Map([['default', profile(['modelSets/heavy'])]]),
  modelSets: new Map([['heavy', { models: ['claude-opus-5-5'], default: 'claude-opus-5-5' }]]),
  settings: undefined,
  logins: [sampleLogin('claude-you', { store: 'ferretry' })],
  templates: new Map(),
  components: NO_COMPONENTS,
  ...overrides,
});

describe('the model Runtimes assembles from its own files', () => {
  it('holds the runtime, its profile, its model set and its login, and says nothing stands in for a document', () => {
    const assembled = assembleRuntimesModel(files());

    expect(Object.keys(assembled.model.runtimes)).toEqual(['claude-default']);
    expect(assembled.model.runtimes['claude-default']).toMatchObject({
      credential: 'claude-you',
      profile: 'default',
    });
    expect(assembled.model.profiles.default?.layers).toEqual(['modelSets/heavy']);
    expect(assembled.model.components.modelSets.heavy?.default).toBe('claude-opus-5-5');
    expect(assembled.model.credentials['claude-you']).toMatchObject({ harness: 'claude', store: 'ferretry' });
    expect(assembled.unreadable).toEqual([]);
    expect(assembled.sources).toBe(4);
  });

  it('keeps who named a runtime from its file, through the model and back to its file (E-296)', () => {
    const assembled = assembleRuntimesModel(
      files({
        runtimes: new Map([
          ['claude-default', runtime({})],
          ['claude-work', runtime({ namedByOwner: true })],
        ]),
      }),
    );

    expect(assembled.model.runtimes['claude-work']?.namedByOwner).toBe(true);
    expect(assembled.model.runtimes['claude-default']?.namedByOwner).toBeUndefined();
    const written = ownedFileBodies(assembled.model);
    expect(written.get('runtimes/claude-work.yaml')).toMatchObject({ namedByOwner: true });
    expect(written.get('runtimes/claude-default.yaml')).not.toHaveProperty('namedByOwner');
  });

  it('reports the agent permissions ferrets really run on a fresh machine: skip, never auto', () => {
    const assembled = assembleRuntimesModel(files());

    expect(assembled.model.machine.agentPermissions).toBe('skip');
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
      'the mcp component "github" could not be read from the part of Ferretry that owns it: no part of Ferretry provides these components yet',
      'the settings component "codex-guard" could not be read from the part of Ferretry that owns it: no part of Ferretry provides these components yet',
    ]);
  });

  it('stands in for an instructions component another plugin owns, with a word that is no file', () => {
    const assembled = assembleRuntimesModel(
      files({ profiles: new Map([['default', profile(['modelSets/heavy', 'instructions/notes'])]]) }),
    );

    expect(assembled.model.components.instructions.notes).toEqual({ file: 'not-read' });
    expect(assembled.unreadable).toEqual([
      'the instructions component "notes" could not be read from the part of Ferretry that owns it: no part of Ferretry provides these components yet',
    ]);
  });

  it('keeps a disabled login’s reason and its expiry, but not a disable that came from a runtime', () => {
    const disabled = (until?: string, source: 'login' | 'runtime' = 'login', reason?: string) =>
      assembleRuntimesModel(
        files({
          logins: [
            sampleLogin('claude-you', {
              store: 'ferretry',
              disabled: {
                source,
                ...(reason === undefined ? {} : { reason }),
                ...(until === undefined ? {} : { until }),
              } as never,
            }),
          ],
        }),
      ).model.credentials['claude-you']?.disabled;

    expect(disabled('2030-01-01T00:00:00.000Z', 'login', 'billing')).toEqual({
      reason: 'billing',
      until: '2030-01-01T00:00:00.000Z',
    });
    expect(disabled(undefined, 'login', undefined)).toEqual({});
    expect(disabled(undefined, 'runtime', 'paused')).toBeUndefined();
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

    expect(assembled.unreadable).toEqual([]);
    expect(assembled.stoodInLogins.map(login => login.id)).toEqual(['glm']);
    expect(JSON.stringify(assembled.stoodInLogins)).not.toContain('GLM_KEY');
    expect(stoodInLoginSentence(standInsNamedBy(assembled.model, assembled.stoodInLogins))).toContain('login "glm"');
    // The secret stays a reference, never a value.
    expect(assembled.model.credentials.glm?.env).toEqual({
      ANTHROPIC_BASE_URL: 'https://api.example.test',
      ANTHROPIC_AUTH_TOKEN: '${secret:GLM_KEY}',
    });
  });

  it('sets a runtime on a login that is not there aside as unavailable, and the other runtimes still load', () => {
    const assembled = assembleRuntimesModel(
      files({
        logins: [sampleLogin('claude-you', { store: 'ferretry' })],
        runtimes: new Map([
          ['claude-default', runtime({})],
          ['orphan', runtime({ login: 'gone' })],
        ]),
        settings: { defaultRuntime: 'orphan' },
      }),
    );

    expect(assembled.unavailable).toEqual([{ runtime: 'orphan', login: 'gone' }]);
    expect(Object.keys(assembled.model.runtimes)).toEqual(['claude-default']);
    // The default naming an unavailable runtime is left unset, never a fault of the whole machine.
    expect(assembled.model.machine.defaultRuntime).toBeUndefined();
    expect(assembled.unreadable).toEqual([]);
  });

  it('with no login at all every runtime is unavailable and the model is empty, not refused', () => {
    const assembled = assembleRuntimesModel(files({ logins: [] }));

    expect(assembled.unavailable).toEqual([{ runtime: 'claude-default', login: 'claude-you' }]);
    expect(Object.keys(assembled.model.runtimes)).toEqual([]);
  });

  it('gives the same revision for the same files and another for a changed one', () => {
    const first = assembleRuntimesModel(files()).revision;

    expect(assembleRuntimesModel(files()).revision).toBe(first);
    expect(
      assembleRuntimesModel(files({ runtimes: new Map([['claude-default', runtime({ shell: 'sh' })]]) })).revision,
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
    const edits = changed(files({ runtimes: new Map([['claude-default', runtime({ compactAt: 'auto' })]]) }));

    expect(edits).toEqual([{ path: 'runtimes/claude-default.yaml', patch: { compactAt: 'auto' } }]);
  });

  it('removes a key the next model no longer has, with an undefined patch value', () => {
    const withShell = assembleRuntimesModel(
      files({ runtimes: new Map([['claude-default', runtime({ shell: 'nix' })]]) }),
    ).model;

    expect(ownedFileEdits(withShell, before)).toEqual([
      { path: 'runtimes/claude-default.yaml', patch: { shell: undefined } },
    ]);
  });

  it('writes a new runtime, profile and model set whole, with the harness spelled as the plugin key', () => {
    const edits = changed(
      files({
        runtimes: new Map([
          ['claude-default', runtime({})],
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
        patch: { login: 'codex-you', profile: 'extra', harness: 'codex' },
      },
      { path: 'profiles/extra.yaml', patch: { contents: [] } },
    ]);
  });

  it('removes the file of a runtime that is gone, and never removes runtimes.yaml', () => {
    // A ready login always has a runtime (derived), so the login is signed out for the runtime to be truly gone.
    const signedOut = sampleLogin('claude-you', {
      store: 'ferretry',
      status: {
        word: 'needs_sign_in',
        label: 'Needs sign-in',
        reason: 'access_current',
        explanation: 'Sign in.',
        lastCheckInconclusive: false,
      },
    });
    const none = assembleRuntimesModel(files({ runtimes: new Map(), logins: [signedOut] })).model;

    expect(ownedFileEdits(before, none)).toEqual([{ path: 'runtimes/claude-default.yaml', remove: true }]);
    expect([...ownedFileBodies(none).keys()]).toContain('runtimes.yaml');
  });

  it('carries a rename as a new file written whole and the old one removed', () => {
    const renamed = changed(files({ runtimes: new Map([['claude-main', runtime({})]]) }));

    expect(renamed).toEqual([
      { path: 'runtimes/claude-main.yaml', patch: { login: 'claude-you', profile: 'default' } },
      { path: 'runtimes/claude-default.yaml', remove: true },
    ]);
  });

  it('moves the default runtime and the auto-resume switch through runtimes.yaml', () => {
    const edits = changed(files({ settings: { defaultRuntime: 'claude-default', autoResume: false } }));

    expect(edits).toEqual([{ path: 'runtimes.yaml', patch: { defaultRuntime: 'claude-default', autoResume: false } }]);
  });
});

describe('C1 the parts of the model no file of Runtimes holds', () => {
  const before = assembleRuntimesModel(files()).model;
  const withMachine = (machine: Record<string, unknown>) => ({ ...before, machine: { ...before.machine, ...machine } });

  it('names every machine setting a change moves except the four runtimes.yaml holds', () => {
    const next = withMachine({
      agentPermissions: 'auto',
      publicUsageFeed: true,
      browserMode: 'window',
      defaultRuntime: 'claude-default',
      autoResume: false,
      browserPorts: 'per-user',
      browserFirewallFailure: 'refuse',
    });

    expect(unownedChanges(before, next as never)).toEqual([
      'the machine setting agentPermissions',
      'the machine setting browserMode',
      'the machine setting publicUsageFeed',
    ]);
  });

  it('names a change of the advanced settings', () => {
    const next = { ...before, advanced: { ...before.advanced, secretsFile: '/x/secrets.env' } };

    expect(unownedChanges(before, next as never)).toEqual(['the advanced settings']);
  });

  it('says nothing for a change of only the default runtime, auto-resume and the two loopback-port settings, or of nothing', () => {
    expect(unownedChanges(before, before)).toEqual([]);
    expect(
      unownedChanges(
        before,
        withMachine({
          defaultRuntime: 'claude-default',
          autoResume: false,
          browserPorts: { cdp: 9300, relay: 9301, vnc: 5901 },
          browserFirewallFailure: 'refuse',
        }) as never,
      ),
    ).toEqual([]);
  });
});

describe('a file naming a harness Runtimes has no behaviour for (runtimes plan U4b)', () => {
  it('sets that login and its runtimes aside, says the file and the sentence, and every other file still loads', () => {
    const assembled = assembleRuntimesModel(
      files({
        logins: [
          sampleLogin('claude-you', { store: 'ferretry' }),
          { ...sampleLogin('typo'), harness: 'gemni', harnesses: ['gemni'] } as never,
        ],
        runtimes: new Map([
          ['claude-default', runtime({})],
          ['on-typo', runtime({ login: 'typo' })],
        ]),
      }),
    );

    expect(Object.keys(assembled.model.runtimes)).toEqual(['claude-default']);
    expect(Object.keys(assembled.model.credentials)).toEqual(['claude-you']);
    expect(assembled.unavailable).toEqual([{ runtime: 'on-typo', login: 'typo' }]);
    expect(assembled.notices).toContain(
      'config/logins/typo.yaml: gemni is not supported here, so this login is not used',
    );
  });

  it('sets a runtime whose own harness is unknown aside by file name, and keeps the rest', () => {
    const assembled = assembleRuntimesModel(
      files({
        runtimes: new Map([
          ['claude-default', runtime({})],
          ['odd', runtime({ harness: 'fake-third' as never })],
        ]),
      }),
    );

    expect(Object.keys(assembled.model.runtimes)).toEqual(['claude-default']);
    expect(assembled.unavailable).toEqual([{ runtime: 'odd', login: 'claude-you' }]);
    expect(assembled.notices).toContain(
      'config/runtimes/odd.yaml: fake-third is not supported here, so this runtime is not started',
    );
  });
});

describe('a component another plugin owns that does not check (runtimes plan U4b)', () => {
  const reading = (rejected: ReadonlyMap<string, string>) => ({
    ...NO_COMPONENTS,
    instructions: {
      state: 'read' as const,
      components: new Map<string, unknown>([['good', { text: 'be kind' }]]),
      rejected,
    },
  });
  const REJECTED = new Map([['odd', '"odd" is not a valid instructions component (gemni is not supported here)']]);

  it('names an unused one in the notices and holds nothing back', () => {
    const assembled = assembleRuntimesModel(
      files({
        profiles: new Map([['default', profile(['modelSets/heavy', 'instructions/good'])]]),
        components: reading(REJECTED),
      }),
    );

    expect(assembled.unreadable).toEqual([]);
    expect(assembled.model.components.instructions.good).toBeDefined();
    expect(assembled.notices).toEqual([
      'the instructions component "odd" is not a valid instructions component (gemni is not supported here), so it is not used',
    ]);
  });

  it('names several in name order, whatever order the owner gave them in', () => {
    const assembled = assembleRuntimesModel(
      files({
        components: reading(
          new Map([
            ['zed', '"zed" is not a valid instructions component (gemni is not supported here)'],
            ['abe', '"abe" is not a valid instructions component (gemni is not supported here)'],
          ]),
        ),
      }),
    );

    expect(assembled.notices?.map(notice => notice.split('"')[1])).toEqual(['abe', 'zed']);
  });

  it('stands in for a used one and says it, naming that component only', () => {
    const assembled = assembleRuntimesModel(
      files({
        profiles: new Map([['default', profile(['modelSets/heavy', 'instructions/good', 'instructions/odd'])]]),
        components: reading(REJECTED),
      }),
    );

    expect(assembled.unreadable).toEqual([
      'the instructions component "odd" is set aside: "odd" is not a valid instructions component (gemni is not supported here)',
    ]);
  });
});
