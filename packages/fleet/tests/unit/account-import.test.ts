import { describe, it } from 'bun:test';
import should from 'should';
import {
  declaredModelIds,
  EMPTY_IMPORT_RECORD,
  freeName,
  type HostDocumentRead,
  type HostHarnessScan,
  type ImportPlan,
  importPreview,
  looksSecret,
  mergeImport,
  mergeImportRecord,
  planImport,
  scannedMcpServers,
} from '../../src/lib/account/import.ts';
import { profileScope } from '../../src/lib/account/scope.ts';
import { FLEET_STARTER_MODELS } from '../../src/lib/defaults.ts';

/** Placeholder secret values: shaped like real ones so detection fires, worthless as credentials. */
const FAKE_KEY = 'sk-placeholder-not-a-real-key-0000';
const FAKE_GH = 'ghp_placeholder000000000000000000';

const digest = (text: string): string => String(Bun.hash(text));

const text = (source: string, body: string): HostDocumentRead => ({
  kind: 'text',
  source,
  text: body,
  bytes: body.length,
});
const absent = (source: string): HostDocumentRead => ({ kind: 'absent', source });

const claude = (patch: Partial<HostHarnessScan> = {}): HostHarnessScan => ({
  harness: 'claude',
  command: '/bin/claude',
  login: { state: 'signed-in', email: 'person@example.test' },
  instructions: absent('/h/.claude/CLAUDE.md'),
  settings: absent('/h/.claude/settings.json'),
  mcp: absent('/h/.claude.json'),
  skills: [],
  missingCommands: [],
  problems: [],
  ...patch,
});

const codex = (patch: Partial<HostHarnessScan> = {}): HostHarnessScan => ({
  harness: 'codex',
  command: '/bin/codex',
  login: { state: 'signed-in' },
  instructions: absent('/h/.codex/AGENTS.md'),
  settings: absent('/h/.codex/config.toml'),
  hooks: absent('/h/.codex/hooks.json'),
  skills: [],
  missingCommands: [],
  problems: [],
  ...patch,
});

const component = (plan: ImportPlan, kind: string, name: string) =>
  plan.components.find(item => item.kind === kind && item.name === name)?.value;

const CLAUDE_SETTINGS = JSON.stringify({
  model: 'claude-opus-5',
  env: { ANTHROPIC_API_KEY: FAKE_KEY, LOG_LEVEL: 'debug', ANTHROPIC_SMALL_FAST_MODEL: 'claude-haiku-5' },
  permissions: { allow: ['Bash(ls)'] },
  hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'fmt' }] }] },
});

const CLAUDE_JSON = JSON.stringify({
  oauthAccount: { emailAddress: 'person@example.test' },
  mcpServers: {
    github: { type: 'stdio', command: 'npx', args: ['-y', 'server-github'], env: { GITHUB_TOKEN: FAKE_GH } },
    notes: { command: 'uvx', args: ['notes'] },
    docs: { type: 'http', url: 'https://mcp.example.test/mcp', headers: { Authorization: 'Bearer x' } },
  },
});

const CODEX_CONFIG = [
  'model = "gpt-5.6"',
  'cli_auth_credentials_store = "file"',
  'sqlite_home = "/somewhere"',
  '[shell_environment_policy]',
  'inherit = "all"',
  '[shell_environment_policy.set]',
  `OPENAI_API_KEY = "${FAKE_KEY}"`,
  '[mcp_servers.github]',
  'command = "npx"',
  'args = ["-y", "server-github"]',
  '[mcp_servers.github.env]',
  `GITHUB_TOKEN = "${FAKE_GH}"`,
  '[mcp_servers.linear]',
  'command = "npx"',
  'args = ["linear"]',
  'startup_timeout_sec = 10',
  '[mcp_servers.off]',
  'command = "x"',
  'enabled = false',
].join('\n');

const fullScans = (): HostHarnessScan[] => [
  claude({
    instructions: text('/h/.claude/CLAUDE.md', '# Be kind\n'),
    settings: text('/h/.claude/settings.json', CLAUDE_SETTINGS),
    mcp: text('/h/.claude.json', CLAUDE_JSON),
    skills: [
      { item: 'review', source: '/h/.claude/skills/review', digest: 'same' },
      { item: 'deploy', source: '/h/.claude/skills/deploy', digest: 'claude-deploy' },
      { item: 'solo', source: '/h/.claude/skills/solo', digest: 'solo' },
    ],
    missingCommands: ['uvx'],
  }),
  codex({
    instructions: text('/h/.codex/AGENTS.md', '# Be kind\r\n\n'),
    settings: text('/h/.codex/config.toml', CODEX_CONFIG),
    hooks: text('/h/.codex/hooks.json', JSON.stringify({ hooks: { Stop: [{ command: 'bell' }] } })),
    skills: [
      { item: 'review', source: '/h/.codex/skills/review', digest: 'same' },
      { item: 'deploy', source: '/h/.codex/skills/deploy', digest: 'codex-deploy' },
    ],
  }),
];

describe('planImport — a machine with both harnesses set up', () => {
  const plan = planImport(fullScans(), { digest });

  it('should share each login in place and never copy it (C1, C3)', () => {
    should(plan.credentials).deepEqual({
      'claude-you': { harness: 'claude', store: 'host' },
      'codex-you': { harness: 'codex', store: 'host' },
    });
  });

  it('should make one generic Instructions component when CLAUDE.md and AGENTS.md match (E9)', () => {
    should(component(plan, 'instructions', 'main')).deepEqual({ file: 'components/instructions/main.md' });
    should(plan.preview.instructionsIdentical).be.true();
    should(plan.notes.map(note => note.text)).containEql('Instructions: same as your CLAUDE.md · one shared copy.');
  });

  it('should move every secret-looking value into the secret store and leave a reference (E7)', () => {
    should(component(plan, 'settings', 'claude-settings')).deepEqual({
      harness: 'claude',
      file: 'components/settings/claude-settings.json',
      env: {
        ANTHROPIC_API_KEY: '${secret:ANTHROPIC_API_KEY}',
        LOG_LEVEL: 'debug',
        ANTHROPIC_SMALL_FAST_MODEL: 'claude-haiku-5',
      },
    });
    should(component(plan, 'settings', 'codex-settings')).deepEqual({
      harness: 'codex',
      file: 'components/settings/codex-settings.toml',
      env: { OPENAI_API_KEY: '${secret:OPENAI_API_KEY}' },
    });
    should(plan.secrets.map(secret => secret.name).sort()).deepEqual([
      'ANTHROPIC_API_KEY',
      'GITHUB_TOKEN',
      'OPENAI_API_KEY',
    ]);
  });

  it('should keep the same value under one secret even when two harnesses hold it', () => {
    should(plan.secrets.filter(secret => secret.name === 'GITHUB_TOKEN')).have.length(1);
  });

  it('should never put a secret value anywhere but plan.secrets', () => {
    const { secrets: _secrets, ...rest } = plan;
    const visible = JSON.stringify(rest);
    should(visible.includes(FAKE_KEY)).be.false();
    should(visible.includes(FAKE_GH)).be.false();
    should(plan.preview.harnesses[0]?.secretKeys).deepEqual(['env.ANTHROPIC_API_KEY', 'mcp.github.env.GITHUB_TOKEN']);
  });

  it('should take hooks and MCP servers out of the settings files', () => {
    const claudeFile = plan.files.find(file => file.path === 'components/settings/claude-settings.json');
    should(claudeFile).deepEqual({
      kind: 'write',
      path: 'components/settings/claude-settings.json',
      content: `${JSON.stringify({ model: 'claude-opus-5', permissions: { allow: ['Bash(ls)'] } }, null, 2)}\n`,
    });
    const codexFile = plan.files.find(file => file.path === 'components/settings/codex-settings.toml');
    should(codexFile?.kind === 'write' && codexFile.content).match(/model = "gpt-5.6"/);
    should(
      codexFile?.kind === 'write' &&
        /mcp_servers|cli_auth_credentials_store|sqlite_home|OPENAI/.test(codexFile.content),
    ).be.false();
    should(codexFile?.kind === 'write' && codexFile.content).match(/inherit = "all"/);
    should(component(plan, 'hooks', 'claude-hooks')).deepEqual({
      harness: 'claude',
      file: 'components/hooks/claude-hooks.json',
    });
    should(component(plan, 'hooks', 'codex-hooks')).deepEqual({
      harness: 'codex',
      file: 'components/hooks/codex-hooks.json',
    });
    should(plan.preview.harnesses[0]?.settings).deepEqual({ source: '/h/.claude/settings.json', count: 5, hooks: 1 });
  });

  it('should share an identical MCP server and keep a different one separately', () => {
    should(component(plan, 'mcp', 'github')).deepEqual({
      command: 'npx',
      args: ['-y', 'server-github'],
      env: { GITHUB_TOKEN: '${secret:GITHUB_TOKEN}' },
    });
    should(component(plan, 'mcp', 'linear')).deepEqual({ command: 'npx', args: ['linear'], harness: 'codex' });
    should(component(plan, 'mcp', 'notes')).deepEqual({ command: 'uvx', args: ['notes'], harness: 'claude' });
    should(component(plan, 'mcp', 'docs')).deepEqual({ url: 'https://mcp.example.test/mcp', harness: 'claude' });
    should(component(plan, 'mcp', 'off')).be.undefined();
  });

  it('should import an MCP server whose command is missing, with a warning (E8)', () => {
    should(plan.warnings['mcp/notes']).deepEqual([
      'Command not found: uvx. Install it on this machine; the server starts working once it is there.',
    ]);
    should(plan.warnings['mcp/docs']).deepEqual([
      'Not imported from your docs server: headers. Add it again yourself.',
    ]);
    should(plan.warnings['mcp/linear']).deepEqual([
      'Not imported from your linear server: startup_timeout_sec. Add it again yourself.',
    ]);
  });

  it('should share identical skills and keep a differing one per harness', () => {
    should(component(plan, 'skills', 'skills')).deepEqual({ items: ['review'] });
    should(component(plan, 'skills', 'claude-skills')).deepEqual({ items: ['deploy', 'solo'], harness: 'claude' });
    should(component(plan, 'skills', 'codex-skills')).deepEqual({ items: ['deploy-codex'], harness: 'codex' });
    should(plan.files).containEql({
      kind: 'copy-directory',
      path: 'skills/deploy-codex',
      from: '/h/.codex/skills/deploy',
    });
    should(plan.notes.map(note => note.text)).containEql(
      'Your Codex skill "deploy" differs from the Claude Code one, so it was kept separately as "deploy-codex".',
    );
  });

  it('should derive each model set from what the settings name', () => {
    should(component(plan, 'modelSets', 'claude-models')).deepEqual({
      models: ['claude-opus-5', 'claude-haiku-5'],
      default: 'claude-opus-5',
    });
    should(component(plan, 'modelSets', 'codex-models')).deepEqual({ models: ['gpt-5.6'], default: 'gpt-5.6' });
  });

  it('should build one profile per harness in the design order, never one mixing both (P7, O2)', () => {
    should(plan.profiles).deepEqual({
      'claude-default': {
        layers: [
          'instructions/main',
          'mcp/github',
          'mcp/notes',
          'mcp/docs',
          'skills/skills',
          'skills/claude-skills',
          'settings/claude-settings',
          'hooks/claude-hooks',
          'modelSets/claude-models',
        ],
      },
      'codex-default': {
        layers: [
          'instructions/main',
          'mcp/github',
          'mcp/linear',
          'skills/skills',
          'skills/codex-skills',
          'settings/codex-settings',
          'hooks/codex-hooks',
          'modelSets/codex-models',
        ],
      },
    });
    should(plan.runtimes).deepEqual({
      'claude-default': { credential: 'claude-you', profile: 'claude-default', agent: true },
      'codex-default': { credential: 'codex-you', profile: 'codex-default', agent: true },
    });
  });

  it('should leave every profile it makes Claude only or Codex only', () => {
    const model = mergeImport(undefined, plan);
    should(profileScope(model, 'claude-default')).deepEqual({ kind: 'scoped', scope: 'claude' });
    should(profileScope(model, 'codex-default')).deepEqual({ kind: 'scoped', scope: 'codex' });
  });

  it('should merge into a document the schema accepts', () => {
    const model = mergeImport(undefined, plan);
    should(Object.keys(model.runtimes)).deepEqual(['claude-default', 'codex-default']);
    should(model.components.mcp.github?.env).deepEqual({ GITHUB_TOKEN: '${secret:GITHUB_TOKEN}' });
  });

  it('should record what it made so Import again can tell what changed', () => {
    should(plan.record.profile).be.undefined();
    should(plan.record.profiles).deepEqual({ claude: 'claude-default', codex: 'codex-default' });
    should(plan.record.components['instructions/main']?.sources).deepEqual([
      '/h/.claude/CLAUDE.md',
      '/h/.codex/AGENTS.md',
    ]);
  });
});

describe('planImport — instructions and harness choices', () => {
  it('should keep different CLAUDE.md and AGENTS.md as two harness-only components (E9)', () => {
    // Act
    const plan = planImport(
      [claude({ instructions: text('/c', 'claude words') }), codex({ instructions: text('/x', 'codex words') })],
      { digest },
    );

    // Assert
    should(component(plan, 'instructions', 'claude-instructions')).deepEqual({
      file: 'components/instructions/claude-instructions.md',
      harness: 'claude',
    });
    should(component(plan, 'instructions', 'codex-instructions')).deepEqual({
      file: 'components/instructions/codex-instructions.md',
      harness: 'codex',
    });
    should(plan.preview.instructionsIdentical).be.false();
    should(plan.notes.map(note => note.text)).containEql(
      'Instructions: different from your CLAUDE.md · kept separately.',
    );
  });

  it('should narrow the one instructions document found when both harnesses are imported', () => {
    const plan = planImport([claude({ instructions: text('/c', 'claude words') }), codex()], { digest });
    should(component(plan, 'instructions', 'claude-instructions')).deepEqual({
      file: 'components/instructions/claude-instructions.md',
      harness: 'claude',
    });
    should(plan.preview.instructionsIdentical).be.undefined();
  });

  it('should import only Claude when Codex is not installed, and say so quietly (E3)', () => {
    // Arrange
    const { command: _command, ...uninstalled } = codex({ instructions: text('/x', 'codex words') });

    // Act
    const plan = planImport(
      [
        claude({ instructions: text('/c', 'claude words'), skills: [{ item: 'a', source: '/a', digest: 'a' }] }),
        uninstalled,
      ],
      { digest },
    );

    // Assert — a lone harness's things stay generic.
    should(plan.imported).deepEqual(['claude']);
    should(component(plan, 'instructions', 'main')).deepEqual({ file: 'components/instructions/main.md' });
    should(component(plan, 'skills', 'skills')).deepEqual({ items: ['a'] });
    should(Object.keys(plan.runtimes)).deepEqual(['claude-default']);
    should(plan.notes).containEql({ harness: 'codex', text: "Codex isn't installed · Install later in Settings." });
    should(plan.preview.harnesses[1]).deepEqual({
      harness: 'codex',
      installed: false,
      account: { state: 'signed-in' },
      missingCommands: [],
      mcpServers: [],
      skills: [],
      secretKeys: [],
      problems: [],
    });
  });

  it('should import only the harnesses the person chose', () => {
    const plan = planImport(fullScans(), { digest, include: ['codex'] });
    should(plan.imported).deepEqual(['codex']);
    should(Object.keys(plan.credentials)).deepEqual(['codex-you']);
  });

  it('should import nothing when nothing is chosen (E10)', () => {
    const plan = planImport(fullScans(), { digest, include: [] });
    should(plan.components).be.empty();
    should(plan.profiles).deepEqual({});
    should(plan.runtimes).deepEqual({});
  });
});

describe('planImport — logins (E4, E6, G5)', () => {
  const noteFor = (login: HostHarnessScan['login']) =>
    planImport([claude({ login })], { digest }).notes.find(note => note.harness === 'claude')?.text;

  it('should say the login is shared with the terminal when signed in', () => {
    should(noteFor({ state: 'signed-in', email: 'a@b.test' })).equal(
      'Login · a@b.test. Ferretry and your own `claude` share this login: signing out in one signs out both.',
    );
    should(noteFor({ state: 'signed-in' })).match(/^Login · your login\./);
  });

  it('should import anyway when a refresh is due (E6)', () => {
    should(noteFor({ state: 'refresh-due' })).equal(
      'Login · your login · Refresh due. Ferretry renews it the first time you launch.',
    );
  });

  it('should import the setup and leave sign-in for later when not signed in (E4)', () => {
    // Act
    const plan = planImport([claude({ login: { state: 'not-signed-in' } })], { digest });

    // Assert
    should(plan.credentials).deepEqual({ 'claude-you': { harness: 'claude', store: 'host' } });
    should(plan.notes[0]?.text).match(/isn't signed in on this machine\. Your setup was still imported/);
  });

  it('should keep an unreadable login as a pointer and say why', () => {
    should(noteFor({ state: 'unreadable', reason: 'keychain locked' })).match(/\(keychain locked\)/);
    should(noteFor({ state: 'unreadable' })).match(/\(no reason given\)/);
  });

  it('should make an empty slot when the login cannot be shared in place (G5)', () => {
    // Act
    const plan = planImport([codex({ login: { state: 'not-shareable', reason: 'keyring' } })], { digest });

    // Assert
    should(plan.credentials).deepEqual({ 'codex-you': { harness: 'codex', store: 'ferretry' } });
    should(plan.notes[0]?.text).equal(
      "Your Codex login can't be shared in place (keyring), so this login needs its own sign-in.",
    );
    should(planImport([codex({ login: { state: 'not-shareable' } })], { digest }).notes[0]?.text).match(
      /\(it is not kept in a file\)/,
    );
  });
});

describe('planImport — nothing found (E5)', () => {
  it('should make a plain Starter profile with only a model set', () => {
    // Act
    const plan = planImport([claude(), codex()], { digest });

    // Assert
    should(plan.profiles).deepEqual({
      'claude-starter': { layers: ['modelSets/claude-models'] },
      'codex-starter': { layers: ['modelSets/codex-models'] },
    });
    should(component(plan, 'modelSets', 'claude-models')).deepEqual({
      models: [FLEET_STARTER_MODELS.claude],
      default: FLEET_STARTER_MODELS.claude,
    });
    should(Object.keys(plan.runtimes)).deepEqual(['claude-starter', 'codex-starter']);
    should(plan.notes.map(note => note.text)).containEql(
      'Nothing found. A plain Starter profile with only a model set. You can add to it later.',
    );
  });

  it('should treat an empty instructions file or settings document as nothing', () => {
    const plan = planImport([claude({ instructions: text('/c', '  \n'), settings: text('/s', '   ') })], { digest });
    should(Object.keys(plan.profiles)).deepEqual(['claude-starter']);
  });
});

describe('planImport — documents it could not use', () => {
  it('should report each unreadable, oversized or invalid document and import the rest', () => {
    // Act
    const plan = planImport(
      [
        claude({
          instructions: { kind: 'too-large', source: '/c', bytes: 9 },
          settings: text('/s', '{not json'),
          mcp: { kind: 'unreadable', source: '/m', reason: 'denied' },
          problems: ['scan problem'],
        }),
        codex({ settings: text('/t', 'x = = 1'), hooks: { kind: 'unreadable', source: '/hk', reason: 'denied' } }),
      ],
      { digest },
    );

    // Assert
    const [claudePreview, codexPreview] = plan.preview.harnesses;
    should(claudePreview?.problems).deepEqual([
      'scan problem',
      'CLAUDE.md at /c is 9 bytes, too large to import',
      'settings.json at /s is not valid json (cannot parse json settings: ' +
        (() => {
          try {
            JSON.parse('{not json');
          } catch (error) {
            return (error as Error).message;
          }
          return '';
        })() +
        '), so it was not imported',
    ]);
    should(codexPreview?.problems.some(problem => problem.startsWith('config.toml at /t is not valid toml'))).be.true();
    should(codexPreview?.problems).containEql('hooks.json at /hk could not be read (denied)');
  });

  it('should leave out environment entries a component cannot carry, saying which', () => {
    // Act
    const plan = planImport(
      [
        claude({
          settings: text(
            '/s',
            JSON.stringify({
              env: {
                CLAUDE_CONFIG_DIR: '/elsewhere',
                'bad-name': 'x',
                NESTED: { a: 1 },
                BROKEN: '${secret:lower}',
                COUNT: 3,
                REF: '$HOME_TOKEN',
                SHORT_TOKEN: 'abc',
              },
            }),
          ),
        }),
      ],
      { digest },
    );

    // Assert
    should(component(plan, 'settings', 'claude-settings')).deepEqual({
      harness: 'claude',
      env: { COUNT: '3', REF: '$HOME_TOKEN', SHORT_TOKEN: 'abc' },
    });
    should(plan.preview.harnesses[0]?.problems).deepEqual([
      'Left out of your settings.json: env.CLAUDE_CONFIG_DIR (Ferretry sets it for each runtime), env.bad-name (not an environment variable name), env.NESTED (not a text value), env.BROKEN (a malformed secret reference).',
    ]);
  });

  it('should skip MCP servers that cannot be imported and skills with unusable names', () => {
    // Act
    const plan = planImport(
      [
        claude({
          mcp: text(
            '/m',
            JSON.stringify({
              mcpServers: {
                nothing: { type: 'stdio' },
                badurl: { url: 'not a url' },
                scalar: 3,
                withenv: { command: 'run', env: { 'bad-name': 'x' } },
              },
            }),
          ),
          skills: [{ item: '..', source: '/x', digest: 'x' }],
        }),
      ],
      { digest },
    );

    // Assert
    should(plan.preview.harnesses[0]?.mcpServers).deepEqual(['withenv']);
    should(component(plan, 'mcp', 'withenv')).deepEqual({ command: 'run' });
    should(plan.warnings['mcp/withenv']).deepEqual([
      'Left out: withenv.env.bad-name (not an environment variable name).',
    ]);
    should(plan.preview.harnesses[0]?.problems).deepEqual([
      'MCP server "nothing" names neither a command nor a url, so it was not imported.',
      'MCP server "badurl" has a url that is not a web address, so it was not imported.',
      'Skill ".." has a folder name Ferretry cannot use, so it was not imported.',
    ]);
  });

  it('should read Codex hooks written without the hooks wrapper', () => {
    const plan = planImport([codex({ hooks: text('/hk', JSON.stringify({ Stop: [{ hooks: [1, 2] }] })) })], {
      digest,
    });
    should(plan.preview.harnesses[0]?.settings).deepEqual({ source: '/hk', count: 0, hooks: 2 });
  });

  it('should drop an empty shell environment policy once its set moves out', () => {
    const plan = planImport([codex({ settings: text('/t', `[shell_environment_policy.set]\nLOG = "1"\n`) })], {
      digest,
    });
    should(component(plan, 'settings', 'codex-settings')).deepEqual({ harness: 'codex', env: { LOG: '1' } });
  });
});

describe('planImport — Import again (O6)', () => {
  const first = planImport(fullScans(), { digest });
  const existing = mergeImport(undefined, first);

  it('should add nothing and report the runtimes that already exist (E15)', () => {
    // Act
    const again = planImport(fullScans(), { digest, existing, record: first.record });

    // Assert
    should(again.components).be.empty();
    should(again.credentials).deepEqual({});
    should(again.updates).be.empty();
    should(again.profiles).deepEqual({});
    should(again.runtimes).deepEqual({});
    should(again.duplicates).deepEqual([
      { harness: 'claude', existing: 'claude-default', suggested: 'claude-default-2' },
      { harness: 'codex', existing: 'codex-default', suggested: 'codex-default-2' },
    ]);
  });

  it('should add a duplicate runtime when asked to anyway', () => {
    const again = planImport(fullScans(), { digest, existing, record: first.record, addDuplicates: ['claude'] });
    should(again.runtimes).deepEqual({
      'claude-default-2': { credential: 'claude-you', profile: 'claude-default', agent: true },
    });
  });

  it('should offer, never apply, an update to a component whose source changed', () => {
    // Arrange
    const scans = fullScans();
    scans[0] = { ...(scans[0] as HostHarnessScan), instructions: text('/h/.claude/CLAUDE.md', '# Be kinder\n') };
    scans[1] = { ...(scans[1] as HostHarnessScan), instructions: text('/h/.codex/AGENTS.md', '# Be kinder\n') };

    // Act
    const again = planImport(scans, { digest, existing, record: first.record });

    // Assert
    should(again.components).be.empty();
    should(again.updates.map(update => update.reference)).deepEqual(['instructions/main']);
    should(mergeImport(existing, again).components.instructions.main).deepEqual(existing.components.instructions.main);
    const accepted = mergeImportRecord(again, ['instructions/main']);
    should(accepted.components['instructions/main']?.digest).equal(again.updates[0]?.digest);
    should(mergeImportRecord(again).components['instructions/main']?.digest).equal(
      first.record.components['instructions/main']?.digest,
    );
  });

  it('should carry the secrets an offered update needs', () => {
    // Arrange
    const scans = fullScans();
    const changed = JSON.stringify({ ...JSON.parse(CLAUDE_SETTINGS), theme: 'dark' });
    scans[0] = { ...(scans[0] as HostHarnessScan), settings: text('/h/.claude/settings.json', changed) };

    // Act
    const again = planImport(scans, { digest, existing, record: first.record, existingSecrets: ['ANTHROPIC_API_KEY'] });
    const update = again.updates.find(entry => entry.reference === 'settings/claude-settings');

    // Assert — the store already has the old name, so the value goes under a fresh one.
    should(update?.secrets.map(secret => secret.name)).deepEqual(['ANTHROPIC_API_KEY_2']);
    should(again.secrets).be.empty();
    const merged = mergeImport(existing, again, ['settings/claude-settings']);
    should(merged.components.settings['claude-settings']?.env?.ANTHROPIC_API_KEY).equal(
      '${secret:ANTHROPIC_API_KEY_2}',
    );
  });

  it('should add what is new and extend the profile the first import made', () => {
    // Arrange
    const scans = fullScans();
    scans[0] = {
      ...(scans[0] as HostHarnessScan),
      skills: [...(scans[0] as HostHarnessScan).skills, { item: 'fresh', source: '/f', digest: 'f' }],
    };

    // Act
    const again = planImport(scans, { digest, existing, record: first.record });

    // Assert — the claude-skills component changed (an update) and nothing was silently replaced.
    should(again.updates.map(update => update.reference)).deepEqual(['skills/claude-skills']);
    should(again.profiles).deepEqual({});
  });

  it('should take the next free name beside a component the person made themselves', () => {
    // Arrange — the person's own "main" and "claude-settings", and a profile called default.
    const own = mergeImport(undefined, planImport([claude({ instructions: text('/o', 'mine') })], { digest }));
    const scans = [
      claude({
        instructions: text('/c', 'theirs'),
        settings: text('/s', JSON.stringify({ theme: 'dark' })),
      }),
    ];
    const personal = mergeImport(
      own,
      planImport([claude({ settings: text('/p', JSON.stringify({ a: 1 })) })], {
        digest,
        existing: own,
        record: EMPTY_IMPORT_RECORD,
      }),
    );

    // Act
    const plan = planImport(scans, { digest, existing: personal });

    // Assert
    should(component(plan, 'instructions', 'main-2')).deepEqual({ file: 'components/instructions/main-2.md' });
    should(plan.files.map(file => file.path)).containEql('components/instructions/main-2.md');
    should(component(plan, 'settings', 'claude-settings-2')).deepEqual({
      harness: 'claude',
      file: 'components/settings/claude-settings-2.json',
    });
    should(Object.keys(plan.profiles)).deepEqual(['claude-default-3']);
    should(plan.credentials).deepEqual({});
    should(Object.keys(plan.runtimes)).deepEqual(['claude-default-3']);
  });

  it('should give a credential a free id when the usual one is taken by another login', () => {
    // Arrange
    const existingModel = mergeImport(
      undefined,
      planImport([codex({ login: { state: 'not-shareable' } })], { digest }),
    );

    // Act
    const plan = planImport([codex({ login: { state: 'not-shareable' } })], { digest, existing: existingModel });

    // Assert
    should(plan.credentials).deepEqual({ 'codex-you-2': { harness: 'codex', store: 'ferretry' } });
  });

  it('should extend an import-made profile with what is new', () => {
    // Arrange
    const base = planImport([claude({ instructions: text('/c', 'x') })], { digest });
    const model = mergeImport(undefined, base);

    // Act
    const again = planImport(
      [claude({ instructions: text('/c', 'x'), skills: [{ item: 'n', source: '/n', digest: 'n' }] })],
      {
        digest,
        existing: model,
        record: base.record,
      },
    );

    // Assert
    should(again.profiles).deepEqual({
      'claude-default': { layers: ['instructions/main', 'modelSets/claude-models', 'skills/skills'] },
    });
  });
});

describe('importPreview', () => {
  it('should be the plan preview, with names and no values', () => {
    const preview = importPreview(fullScans());
    should(JSON.stringify(preview).includes(FAKE_KEY)).be.false();
    should(preview.harnesses.map(harness => harness.mcpServers)).deepEqual([
      ['github', 'notes', 'docs'],
      ['github', 'linear'],
    ]);
    should(preview.harnesses[0]?.instructions).deepEqual({
      name: 'CLAUDE.md',
      source: '/h/.claude/CLAUDE.md',
      bytes: 10,
    });
  });
});

describe('looksSecret', () => {
  it('should flag credential-shaped names and token-shaped values', () => {
    should(looksSecret('GITHUB_TOKEN', 'abcdefghij')).be.true();
    should(looksSecret('OPENAI_API_KEY', 'abcdefghij')).be.true();
    should(looksSecret('apiKey', 'abcdefghij')).be.true();
    should(looksSecret('APIKEY', 'abcdefghij')).be.true();
    should(looksSecret('ANYTHING', FAKE_GH)).be.true();
  });

  it('should leave flags, references and ordinary values alone', () => {
    should(looksSecret('AUTH', '1')).be.false();
    should(looksSecret('GITHUB_TOKEN', '$GITHUB_TOKEN')).be.false();
    should(looksSecret('GITHUB_TOKEN', '${GITHUB_TOKEN}')).be.false();
    should(looksSecret('GITHUB_TOKEN', 'Bearer ${secret:GITHUB}')).be.false();
    should(looksSecret('LOG_LEVEL', 'debugging')).be.false();
  });
});

describe('freeName', () => {
  it('should return the name when free, else the first free -N', () => {
    should(freeName('a', () => false)).equal('a');
    should(freeName('a', name => name === 'a' || name === 'a-2')).equal('a-3');
  });
});

describe('declaredModelIds', () => {
  it('should read the model, env names ending in MODEL and profile models, once each', () => {
    should(
      declaredModelIds({
        model: ' gpt-5 ',
        env: { SMALL_MODEL: 'gpt-4', OTHER: 'x', MODEL: 'gpt-5' },
        profiles: { a: { model: 'o3' }, b: 'scalar', c: { model: '' } },
      }),
    ).deepEqual(['gpt-5', 'gpt-4', 'o3']);
    should(declaredModelIds({ model: 3 })).deepEqual([]);
  });
});

describe('scannedMcpServers', () => {
  it('should read no servers from a Claude scan with no .claude.json', () => {
    const { mcp: _mcp, ...withoutMcp } = claude();
    should(scannedMcpServers(withoutMcp)).deepEqual([]);
  });

  it('should drop the env of a url server and the args of an empty list', () => {
    should(
      scannedMcpServers(
        claude({
          mcp: text(
            '/m',
            JSON.stringify({
              mcpServers: { a: { url: 'https://x.test', env: { A: 'b' } }, b: { command: 'c', args: [] } },
            }),
          ),
        }),
      ),
    ).deepEqual([
      { name: 'a', url: 'https://x.test', ignored: [] },
      { name: 'b', command: 'c', ignored: [] },
    ]);
  });
});

describe('secret names', () => {
  it('should give a name that does not start with a letter a prefix, and two values two names', () => {
    // Act
    const plan = planImport(
      [
        claude({
          settings: text('/s', JSON.stringify({ env: { _TOKEN: FAKE_KEY } })),
          mcp: text('/m', JSON.stringify({ mcpServers: { a: { command: 'a', env: { _TOKEN: FAKE_GH } } } })),
        }),
      ],
      { digest },
    );

    // Assert
    should(plan.secrets.map(secret => [secret.name, secret.from])).deepEqual([
      ['S__TOKEN', 'settings.json · env._TOKEN'],
      ['S__TOKEN_2', 'claude MCP server a · a.env._TOKEN'],
    ]);
  });
});

describe('planImport — one profile per harness (P7)', () => {
  it('should make a profile for a harness imported for the first time from what an earlier import made', () => {
    // Arrange — Claude alone first, so its instructions are generic and its profile is Claude only.
    const first = planImport([claude({ instructions: text('/c', 'shared words') })], { digest });
    const existing = mergeImport(undefined, first);

    // Act
    const again = planImport([claude({ instructions: text('/c', 'shared words') }), codex()], {
      digest,
      existing,
      record: first.record,
      include: ['codex'],
    });

    // Assert — Codex gets the generic instructions the first import made, and its own model set.
    should(again.profiles).deepEqual({
      'codex-default': { layers: ['instructions/main', 'modelSets/codex-models'] },
    });
    should(again.runtimes).deepEqual({
      'codex-default': { credential: 'codex-you', profile: 'codex-default', agent: true },
    });
    should(again.record.profiles).deepEqual({ claude: 'claude-default', codex: 'codex-default' });
  });

  it('should make a Starter for a harness with nothing found, beside a model set the person made', () => {
    // Arrange — a Starter for Claude, whose model set is all a record holds.
    const first = planImport([claude()], { digest });
    const existing = mergeImport(undefined, first);

    // Act — Codex arrives with nothing found, and the person already has a set under the name it wants.
    const own = {
      ...existing,
      components: {
        ...existing.components,
        modelSets: { ...existing.components.modelSets, 'codex-models': { models: ['gpt-6'], default: 'gpt-6' } },
      },
    };
    const again = planImport([claude(), codex()], { digest, existing: own, record: first.record, include: ['codex'] });

    // Assert
    should(again.profiles).deepEqual({ 'codex-starter': { layers: ['modelSets/codex-models-2'] } });
  });

  it('should still extend the ONE shared profile a record written before P7 names', () => {
    // Arrange — the old shape: one Default holding both harnesses' parts, recorded as `profile`.
    const first = planImport(fullScans(), { digest });
    const shared = mergeImport(undefined, first);
    const legacyLayers = [
      ...(shared.profiles['claude-default']?.layers ?? []),
      ...(shared.profiles['codex-default']?.layers ?? []),
    ].filter((layer, index, all) => all.indexOf(layer) === index && layer !== 'mcp/linear');
    const { linear: _linear, ...mcp } = shared.components.mcp;
    const { 'mcp/linear': _recorded, ...components } = first.record.components;
    const existing = {
      ...shared,
      components: { ...shared.components, mcp },
      profiles: { default: { layers: legacyLayers } },
      runtimes: {
        'claude-default': { credential: 'claude-you', profile: 'default', agent: true },
        'codex-default': { credential: 'codex-you', profile: 'default', agent: true },
      },
    };
    const record = { version: 1 as const, components, profile: 'default' };

    // Act — Codex's "linear" server is new since that import.
    const again = planImport(fullScans(), { digest, existing, record });

    // Assert — the legacy profile takes what is new; no per-harness profile appears beside it.
    should(again.profiles.default?.layers.at(-1)).equal('mcp/linear');
    should(Object.keys(again.profiles)).deepEqual(['default']);
    should(again.record.profile).equal('default');
    should(again.record.profiles).deepEqual({ claude: 'default', codex: 'default' });
    should(again.duplicates.map(duplicate => duplicate.existing)).deepEqual(['claude-default', 'codex-default']);
  });
});
