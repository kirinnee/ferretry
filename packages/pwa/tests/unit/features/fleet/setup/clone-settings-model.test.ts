import { describe, expect, it } from 'bun:test';
import { type FleetCloneBundle, mcpOAuthSecretNames, type SpeedupsView, secretReference } from '@ferretry/protocol';
import {
  ALL_CLONE_ITEMS,
  CLONE_ITEMS,
  type CloneItem,
  type CloneItemId,
  type CloneNeed,
  cloneLogins,
  cloneNeeds,
  controlsChange,
  keysToCopy,
  needsSentence,
  outcomeSentence,
  providersNeededBy,
  type SourceSettingsFile,
  sourceItemSummary,
} from '../../../../../src/features/fleet/setup/clone-settings-model.ts';
import { bundle, machineView } from './setup-support.ts';

const filesOf = (...list: readonly SourceSettingsFile[]): ReadonlyMap<string, SourceSettingsFile> =>
  new Map(list.map(file => [file.path, file]));

const present = (path: string, text: string): SourceSettingsFile => ({ path, exists: true, text });

const speedups = (
  ...secrets: readonly [provider: 'jev' | 'groq' | 'cerebras', secretName: string][]
): SpeedupsView => ({
  vault: 'ok',
  providers: secrets.map(([provider, secretName]) => ({
    provider,
    label: provider,
    purpose: 'Speeds something up.',
    costNote: 'Cheap.',
    privacyNote: 'Sends text.',
    keyUrl: 'https://example.com/keys',
    testNote: 'Spends a little.',
    secretName,
    set: false,
    testStale: false,
  })),
});

const ENV_BUNDLE = (overrides: Partial<FleetCloneBundle> = {}): FleetCloneBundle =>
  bundle({ credentials: [], components: {}, files: [], ...overrides });

const itemOf = (id: CloneItemId): CloneItem => CLONE_ITEMS.find(item => item.id === id) as CloneItem;

describe('the clone items', () => {
  it('lists fleet, warden, learning, voice, then controls, in the order the preview shows them', () => {
    expect(CLONE_ITEMS.map(item => item.id)).toEqual(['fleet', 'warden', 'learning', 'voice', 'controls']);
    expect(ALL_CLONE_ITEMS).toEqual(['fleet', 'warden', 'learning', 'voice', 'controls']);
  });

  it('names the configuration file only for the items copied as one', () => {
    expect(CLONE_ITEMS.map(item => item.file)).toEqual([
      undefined,
      'warden.yaml',
      'learning.yaml',
      'voice.yaml',
      undefined,
    ]);
  });
});

describe('sourceItemSummary', () => {
  it('counts the fleet in plural words, singular for one', () => {
    expect(sourceItemSummary('fleet', filesOf(), null, bundle())).toBe('1 profile, 3 runtimes, 2 logins');
    expect(
      sourceItemSummary(
        'fleet',
        filesOf(),
        null,
        bundle({
          profiles: { a: {}, b: {} },
          runtimes: { only: {} },
          credentials: [{ id: 'claude-work', harness: 'claude' }],
        }),
      ),
    ).toBe('2 profiles, 1 runtime, 1 login');
  });

  it('says the fleet was not read when there is no bundle', () => {
    expect(sourceItemSummary('fleet', filesOf(), machineView(), null)).toBe('Not read');
  });

  it('lists the controls that are on with the default runtime', () => {
    expect(sourceItemSummary('controls', filesOf(), machineView(), null)).toBe(
      'terminals, browsers, files · default runtime claude-default',
    );
  });

  it('says no controls, and the automatic runtime, when nothing is on and no runtime resolves', () => {
    const machine = machineView({
      agentControl: { terminals: false, browsers: false, files: false, ferretrySettings: false, pageScripts: false },
      defaultRuntime: null,
    });
    expect(sourceItemSummary('controls', filesOf(), machine, null)).toBe('no controls · default runtime automatic');
  });

  it('says the controls were not read when there is no machine view', () => {
    expect(sourceItemSummary('controls', filesOf(), null, bundle())).toBe('Not read');
  });

  it('says a settings file was not read when the source returned nothing for it', () => {
    expect(sourceItemSummary('warden', filesOf(), null, null)).toBe('Not read');
  });

  it('says a file the source has not set copies the defaults', () => {
    const files = filesOf({ path: 'voice.yaml', exists: false, text: '' });
    expect(sourceItemSummary('voice', files, null, null)).toBe('Not set on the source: copies the defaults');
  });

  it('says Defaults when the file holds no top-level setting', () => {
    const files = filesOf(present('learning.yaml', '# nothing here\n\nnested:\n  key: value\n'));
    expect(sourceItemSummary('learning', files, null, null)).toBe('Defaults');
  });

  it('shows the top-level key lines with comments stripped, three at most', () => {
    const files = filesOf(
      present(
        'warden.yaml',
        [
          '# the warden',
          'enabled: true  # on',
          'triage: jev',
          '  indented: ignored',
          'interval: 30s',
          'budget: 5',
          'caps: 9',
        ].join('\n'),
      ),
    );
    expect(sourceItemSummary('warden', files, null, null)).toBe('enabled: true · triage: jev · interval: 30s');
  });
});

describe('providersNeededBy', () => {
  it('names jev for a warden file whose triage is jev', () => {
    expect(providersNeededBy('warden.yaml', 'triage: jev\n')).toEqual(['jev']);
    expect(providersNeededBy('warden.yaml', 'enabled: true\ntriage: jev\n')).toEqual(['jev']);
  });

  it('reads a quoted jev too', () => {
    expect(providersNeededBy('warden.yaml', "triage: 'jev'\n")).toEqual(['jev']);
    expect(providersNeededBy('warden.yaml', 'triage: "jev"\n')).toEqual(['jev']);
  });

  it('needs nothing from a warden that is disabled or triages another way', () => {
    expect(providersNeededBy('warden.yaml', 'enabled: false\ntriage: jev\n')).toEqual([]);
    expect(providersNeededBy('warden.yaml', 'triage: local\n')).toEqual([]);
    expect(providersNeededBy('warden.yaml', '')).toEqual([]);
  });

  it('names groq or cerebras for voice clean-up on that provider', () => {
    expect(providersNeededBy('voice.yaml', 'provider: groq\n')).toEqual(['groq']);
    expect(providersNeededBy('voice.yaml', '  provider: cerebras # fast\n')).toEqual(['cerebras']);
  });

  it('needs nothing for voice clean-up that is off or signs in', () => {
    expect(providersNeededBy('voice.yaml', 'provider: off\n')).toEqual([]);
    expect(providersNeededBy('voice.yaml', 'provider: login\n')).toEqual([]);
    expect(providersNeededBy('voice.yaml', '')).toEqual([]);
  });

  it('needs nothing from any other path', () => {
    expect(providersNeededBy('learning.yaml', 'triage: jev\nprovider: groq\n')).toEqual([]);
  });
});

describe('cloneNeeds', () => {
  it('names a speed-up key from the Speedups view and marks it held from the secret names', () => {
    const files = filesOf(present('warden.yaml', 'triage: jev\n'), present('voice.yaml', 'provider: groq\n'));
    const view = speedups(['jev', 'JEV_API_KEY'], ['groq', 'GROQ_API_KEY']);
    const needs = cloneNeeds(['warden', 'voice'], null, files, view, ['GROQ_API_KEY']);
    expect(needs).toEqual([
      {
        key: 'secret:JEV_API_KEY',
        kind: 'secret',
        name: 'JEV_API_KEY',
        secretName: 'JEV_API_KEY',
        why: 'the Warden’s Jev guard',
        held: false,
      },
      {
        key: 'secret:GROQ_API_KEY',
        kind: 'secret',
        name: 'GROQ_API_KEY',
        secretName: 'GROQ_API_KEY',
        why: 'voice clean-up on Groq',
        held: true,
      },
    ]);
  });

  it('names a cerebras key by its own reason', () => {
    const files = filesOf(present('voice.yaml', 'provider: cerebras\n'));
    const [need] = cloneNeeds(['voice'], null, files, speedups(['cerebras', 'CEREBRAS_API_KEY']), []);
    expect(need?.why).toBe('voice clean-up on Cerebras');
  });

  it('names a provider key with no field, never held, when the Speedups view is not available', () => {
    const files = filesOf(present('warden.yaml', 'triage: jev\n'));
    const asked = cloneNeeds(['warden'], null, files, null, ['JEV_API_KEY']);
    expect(asked).toEqual([
      { key: 'secret:jev key', kind: 'secret', name: 'jev key', why: 'the Warden’s Jev guard', held: false },
    ]);
    expect(asked[0]).not.toHaveProperty('secretName');
  });

  it('names a provider key with no field when the view lacks that provider', () => {
    const files = filesOf(present('voice.yaml', 'provider: groq\n'));
    const [need] = cloneNeeds(['voice'], null, files, speedups(['jev', 'JEV_API_KEY']), ['GROQ_API_KEY']);
    expect(need).toMatchObject({ name: 'groq key', held: false });
    expect(need).not.toHaveProperty('secretName');
  });

  it('lists the secret references a copied file carries', () => {
    const files = filesOf(
      present('learning.yaml', `token: ${secretReference('LESSON_TOKEN')}\nother: ${secretReference('OTHER_TOKEN')}\n`),
    );
    const needs = cloneNeeds(['learning'], null, files, null, ['OTHER_TOKEN']);
    expect(needs).toEqual([
      {
        key: 'secret:LESSON_TOKEN',
        kind: 'secret',
        name: 'LESSON_TOKEN',
        secretName: 'LESSON_TOKEN',
        why: 'Learning defaults',
        held: false,
      },
      {
        key: 'secret:OTHER_TOKEN',
        kind: 'secret',
        name: 'OTHER_TOKEN',
        secretName: 'OTHER_TOKEN',
        why: 'Learning defaults',
        held: true,
      },
    ]);
  });

  it('lists each secret once, under the first reason that named it', () => {
    const files = filesOf(
      present('warden.yaml', `triage: jev\nkey: ${secretReference('JEV_API_KEY')}\n`),
      present('voice.yaml', `provider: groq\nkey: ${secretReference('JEV_API_KEY')}\n`),
    );
    const needs = cloneNeeds(['warden', 'voice'], null, files, speedups(['jev', 'JEV_API_KEY']), []);
    expect(needs.map(need => need.name)).toEqual(['JEV_API_KEY', 'groq key']);
    expect(needs[0]?.why).toBe('the Warden’s Jev guard');
  });

  it('contributes nothing for an item that was not chosen', () => {
    const files = filesOf(
      present('warden.yaml', `triage: jev\nkey: ${secretReference('JEV_API_KEY')}\n`),
      present('voice.yaml', 'provider: groq\n'),
    );
    expect(cloneNeeds(['voice'], null, files, null, []).map(need => need.name)).toEqual(['groq key']);
    expect(cloneNeeds([], bundle(), files, null, [])).toEqual([]);
  });

  it('contributes nothing for a source file that is absent or was never read', () => {
    const files = filesOf({ path: 'warden.yaml', exists: false, text: 'triage: jev\n' });
    expect(cloneNeeds(['warden', 'learning', 'voice'], null, files, null, [])).toEqual([]);
  });

  it('names the secrets a copied component, a bundled file and an environment login reference', () => {
    const copied = ENV_BUNDLE({
      components: { mcp: { notes: { env: { TOKEN: secretReference('NOTES_TOKEN') } } } },
      files: [{ path: 'components/settings/default.json', content: `{"k":"${secretReference('FILE_KEY')}"}` }],
      credentials: [
        {
          id: 'glm-env',
          harness: 'claude',
          store: 'environment',
          env: { A: secretReference('GLM_KEY'), B: 'plain', C: secretReference('NOTES_TOKEN') },
        },
      ],
    });
    const needs = cloneNeeds(['fleet'], copied, filesOf(), null, ['FILE_KEY']);
    expect(needs).toEqual([
      {
        key: 'secret:NOTES_TOKEN',
        kind: 'secret',
        name: 'NOTES_TOKEN',
        secretName: 'NOTES_TOKEN',
        why: 'a copied component',
        held: false,
      },
      {
        key: 'secret:FILE_KEY',
        kind: 'secret',
        name: 'FILE_KEY',
        secretName: 'FILE_KEY',
        why: 'components/settings/default.json',
        held: true,
      },
      {
        key: 'secret:GLM_KEY',
        kind: 'secret',
        name: 'GLM_KEY',
        secretName: 'GLM_KEY',
        why: 'login glm-env',
        held: false,
      },
    ]);
  });

  it('reads the key of a login that drives both CLIs from either half, not only from env', () => {
    const copied = ENV_BUNDLE({
      credentials: [
        {
          id: 'glm-both',
          harness: 'claude',
          store: 'environment',
          claude: { env: { ANTHROPIC_AUTH_TOKEN: secretReference('ZAI_API_KEY') } },
          codex: { env: { ZAI_API_KEY: secretReference('ZAI_API_KEY') } },
        },
      ],
    });
    expect(cloneNeeds(['fleet'], copied, filesOf(), null, []).map(need => need.name)).toEqual(['ZAI_API_KEY']);
  });

  it('reads an environment login with no env as needing nothing', () => {
    const copied = ENV_BUNDLE({ credentials: [{ id: 'bare-env', harness: 'codex', store: 'environment' }] });
    expect(cloneNeeds(['fleet'], copied, filesOf(), null, [])).toEqual([]);
  });

  it('lists a sign-in login as a sign-in need with its credential id, never held', () => {
    const copied = ENV_BUNDLE({
      credentials: [
        { id: 'claude-work', harness: 'claude', email: 'me@work.example' },
        { id: 'codex-work', harness: 'codex', label: 'Work' },
        { id: 'codex-bare', harness: 'codex' },
      ],
    });
    const needs = cloneNeeds(['fleet'], copied, filesOf(), null, ['claude-work', 'codex-work']);
    expect(needs).toEqual([
      {
        key: 'sign-in:claude-work',
        kind: 'sign-in',
        name: 'Claude Code login (claude-work)',
        credentialId: 'claude-work',
        why: 'me@work.example',
        held: false,
      },
      {
        key: 'sign-in:codex-work',
        kind: 'sign-in',
        name: 'Codex login (codex-work)',
        credentialId: 'codex-work',
        why: 'Work',
        held: false,
      },
      {
        key: 'sign-in:codex-bare',
        kind: 'sign-in',
        name: 'Codex login (codex-bare)',
        credentialId: 'codex-bare',
        why: 'signed in on the source',
        held: false,
      },
    ]);
  });

  it('lists secrets first and sign-ins after, however the sources are ordered', () => {
    const copied = ENV_BUNDLE({
      credentials: [
        { id: 'claude-work', harness: 'claude' },
        { id: 'glm-env', harness: 'claude', store: 'environment', env: { A: secretReference('GLM_KEY') } },
      ],
    });
    const files = filesOf(present('warden.yaml', 'triage: jev\n'));
    expect(cloneNeeds(['fleet', 'warden'], copied, files, null, []).map(need => need.key)).toEqual([
      'secret:jev key',
      'secret:GLM_KEY',
      'sign-in:claude-work',
    ]);
  });

  it('needs nothing from the fleet when it is not chosen or has no bundle', () => {
    expect(cloneNeeds(['warden'], bundle(), filesOf(), null, [])).toEqual([]);
    expect(cloneNeeds(['fleet'], null, filesOf(), null, [])).toEqual([]);
  });
});

describe('cloneLogins', () => {
  const LOGINS = ENV_BUNDLE({
    credentials: [
      { id: 'claude-work', harness: 'claude', email: 'me@work.example' },
      {
        id: 'glm-env',
        harness: 'claude',
        label: 'GLM',
        store: 'environment',
        env: { ANTHROPIC_AUTH_TOKEN: secretReference('ZAI_API_KEY') },
      },
      { id: 'codex-work', harness: 'codex', label: 'Work' },
      { id: 'cloud-env', harness: 'claude', store: 'environment', cloudCredential: 'aws-profile:dev' },
    ],
  });

  it('puts API-key logins first, then sign-ins, each with what it needs here', () => {
    expect(cloneLogins(LOGINS, ['ZAI_API_KEY'])).toEqual([
      { kind: 'api-key', id: 'glm-env', harness: 'claude', name: 'GLM', keys: [{ name: 'ZAI_API_KEY', held: true }] },
      { kind: 'api-key', id: 'cloud-env', harness: 'claude', name: 'cloud-env', keys: [] },
      { kind: 'sign-in', id: 'claude-work', harness: 'claude', name: 'me@work.example' },
      { kind: 'sign-in', id: 'codex-work', harness: 'codex', name: 'Work' },
    ]);
  });

  it('marks a key this machine lacks as not held, and lists nothing without a bundle', () => {
    expect(cloneLogins(LOGINS, [])[0]).toMatchObject({ keys: [{ name: 'ZAI_API_KEY', held: false }] });
    expect(cloneLogins(null, [])).toEqual([]);
  });
});

describe('keysToCopy', () => {
  const need = (name: string, over: Partial<CloneNeed> = {}): CloneNeed => ({
    key: `secret:${name}`,
    kind: 'secret',
    name,
    secretName: name,
    why: 'login glm-env',
    held: false,
    ...over,
  });

  it('seals the keys this machine lacks and the source holds, in the order they are needed', () => {
    const needs = [need('ZAI_API_KEY'), need('GROQ_API_KEY', { held: true }), need('JEV_API_KEY')];
    expect(keysToCopy(needs, ['JEV_API_KEY', 'ZAI_API_KEY', 'GROQ_API_KEY'])).toEqual(['ZAI_API_KEY', 'JEV_API_KEY']);
  });

  it('never asks the source for a key it does not hold', () => {
    expect(keysToCopy([need('ZAI_API_KEY'), need('OTHER_KEY')], ['ZAI_API_KEY'])).toEqual(['ZAI_API_KEY']);
  });

  it('sends nothing when the source list could not be read, rather than guessing', () => {
    expect(keysToCopy([need('ZAI_API_KEY')], null)).toEqual([]);
  });

  it('never sends a sign-in, a need with no secret name, or a sign-in token by any route', () => {
    const token = mcpOAuthSecretNames('linear', 'https://mcp.example.com/mcp').access;
    const signIn: CloneNeed = {
      key: 'sign-in:claude-work',
      kind: 'sign-in',
      name: 'Claude Code login (claude-work)',
      credentialId: 'claude-work',
      why: 'me@work.example',
      held: false,
    };
    const { secretName: _omitted, ...nameless } = need('JEV key');
    expect(keysToCopy([signIn, nameless, need(token)], ['JEV key', token, 'claude-work'])).toEqual([]);
  });
});

describe('needsSentence', () => {
  const secret = (name: string, held: boolean): CloneNeed => ({
    key: `secret:${name}`,
    kind: 'secret',
    name,
    secretName: name,
    why: 'a reason',
    held,
  });

  it('names what is not held yet, in order', () => {
    const signIn: CloneNeed = {
      key: 'sign-in:claude-work',
      kind: 'sign-in',
      name: 'Claude Code login (claude-work)',
      credentialId: 'claude-work',
      why: 'signed in on the source',
      held: false,
    };
    expect(needsSentence([secret('JEV_API_KEY', false), secret('GROQ_API_KEY', true), signIn])).toBe(
      'JEV_API_KEY, Claude Code login (claude-work)',
    );
  });

  it('is null when every need is held, or there are none', () => {
    expect(needsSentence([secret('JEV_API_KEY', true)])).toBeNull();
    expect(needsSentence([])).toBeNull();
  });
});

describe('controlsChange', () => {
  it('turns the source controls and default runtime into one machine.settings change', () => {
    const source = machineView({
      agentPermissions: 'skip',
      defaultRuntime: null,
      agentControl: { terminals: false, browsers: true, files: false, ferretrySettings: true, pageScripts: false },
    });
    expect(controlsChange(source)).toEqual({
      kind: 'machine.settings',
      agentPermissions: 'skip',
      defaultRuntime: null,
      agentControl: { terminals: false, browsers: true, files: false, ferretrySettings: true, pageScripts: false },
    });
  });
});

describe('outcomeSentence', () => {
  const warden = itemOf('warden');

  it('says a copied item is in effect now', () => {
    expect(outcomeSentence(warden, { kind: 'copied' })).toBe('Warden: copied, in effect now.');
  });

  it('says a pending item waits for the owner and lists what it loosens', () => {
    expect(
      outcomeSentence(warden, {
        kind: 'pending',
        path: 'warden.yaml',
        etag: 'abc',
        changes: ['raises the daily cap', 'agents may act alone'],
      }),
    ).toBe(
      'Warden: copied, and waiting for your confirmation because it loosens something: raises the daily cap; agents may act alone.',
    );
  });

  it('says a refused item was not copied, with the reason', () => {
    expect(outcomeSentence(itemOf('voice'), { kind: 'refused', reason: 'The file does not check.' })).toBe(
      'Voice clean-up: not copied. The file does not check.',
    );
  });
});
