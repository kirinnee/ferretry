import { describe, it } from 'bun:test';
import should from 'should';
import * as config from '../../src/lib/config-files.ts';
import { INSTANT } from '../fixtures.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

type Address = config.ConfigFileAddress;

/** Every kind of file, with the path it lives at and the schema id it is checked against. */
const FILES: readonly { readonly address: Address; readonly path: string; readonly schema: config.ConfigSchemaId }[] = [
  { address: { kind: 'machine' }, path: 'machine.yaml', schema: 'machine' },
  { address: { kind: 'warden' }, path: 'warden.yaml', schema: 'warden' },
  { address: { kind: 'learning' }, path: 'learning.yaml', schema: 'learning' },
  { address: { kind: 'voice' }, path: 'voice.yaml', schema: 'voice' },
  { address: { kind: 'pack' }, path: 'pack.yaml', schema: 'pack' },
  { address: { kind: 'modelsGuide' }, path: 'models-guide.yaml', schema: 'modelsGuide' },
  { address: { kind: 'login', name: 'claude-you' }, path: 'logins/claude-you.yaml', schema: 'login' },
  { address: { kind: 'profile', name: 'default' }, path: 'profiles/default.yaml', schema: 'profile' },
  { address: { kind: 'runtime', name: 'claude-default' }, path: 'runtimes/claude-default.yaml', schema: 'runtime' },
  { address: { kind: 'preset', name: 'my-gateway' }, path: 'presets/my-gateway.yaml', schema: 'preset' },
  { address: { kind: 'models', name: 'zai' }, path: 'models/zai.yaml', schema: 'models' },
  ...config.CONFIG_COMPONENT_KINDS.map(componentKind => ({
    address: { kind: 'component', componentKind, name: 'main' } as const,
    path: `components/${componentKind}/main.yaml`,
    schema: `component-${componentKind}` as const,
  })),
];

describe('where a configuration file lives', () => {
  it.each(FILES.map(file => [file.path, file] as const))(
    'should classify %s and write it back to the same path',
    (_path, file) => {
      // Arrange
      const input = file.path;

      // Act
      const actual = config.classifyConfigPath(input);

      // Assert
      should(actual).deepEqual(file.address);
      should(config.configFilePath(file.address)).equal(file.path);
    },
  );

  it('should cover every kind of file in the round-trip table', () => {
    // Assert — a kind added to the protocol without a row here is a kind nobody tested.
    should(new Set(FILES.map(file => file.address.kind))).deepEqual(new Set(config.CONFIG_FILE_KINDS));
    should(FILES.filter(file => file.address.kind === 'component').length).equal(config.CONFIG_COMPONENT_KINDS.length);
  });

  it.each([
    ['an extension other than .yaml', 'machine.yml'],
    ['no extension', 'machine'],
    ['a json file', 'profiles/default.json'],
    ['a .yml component', 'components/mcp/github.yml'],
    ['an empty path', ''],
    ['only the extension', '.yaml'],
    ['a file Ferretry has no singleton for', 'settings.yaml'],
    ['a singleton below a directory', 'config/machine.yaml'],
    ['a named kind with no directory', 'default.yaml'],
    ['an unknown directory', 'agents/main.yaml'],
    ['a singleton name used as a directory', 'warden/main.yaml'],
    ['a hidden stem', 'profiles/.default.yaml'],
    ['an editor backup stem', 'profiles/.#default.yaml'],
    ['an empty stem', 'profiles/.yaml'],
    ['a traversing stem', 'logins/a..b.yaml'],
    ['a traversal directory', '../machine.yaml'],
    ['a traversal in the middle', 'profiles/../machine.yaml'],
    ['a backslash in a stem', 'profiles/a\\b.yaml'],
    ['a control character in a stem', 'profiles/a\u0007b.yaml'],
    ['a stem past 64 characters', `profiles/${'a'.repeat(65)}.yaml`],
    ['an unknown component kind', 'components/prompts/main.yaml'],
    ['a component kind with the wrong case', 'components/modelsets/heavy.yaml'],
    ['a component with a hidden stem', 'components/mcp/.github.yaml'],
    ['a component directory with the wrong name', 'component/mcp/github.yaml'],
    ['a component kind with no name', 'components/mcp.yaml'],
    ['one level too deep', 'components/mcp/github/extra.yaml'],
    ['a named kind one level too deep', 'profiles/team/default.yaml'],
    ['a singleton two levels deep', 'a/b/machine.yaml'],
  ])('should not read %s', (_label, input) => {
    // Act
    const actual = config.classifyConfigPath(input);

    // Assert
    should(actual).be.undefined();
  });

  it('should read a stem of exactly 64 characters and refuse one of 65', () => {
    // Arrange
    const longest = 'a'.repeat(64);

    // Act + Assert
    should(config.classifyConfigPath(`profiles/${longest}.yaml`)).deepEqual({ kind: 'profile', name: longest });
    should(config.classifyConfigPath(`profiles/${longest}a.yaml`)).be.undefined();
  });

  it('should name the schema each file is checked against: one per singleton, named kind and component kind', () => {
    // Act + Assert
    for (const file of FILES) should(config.configSchemaId(file.address)).equal(file.schema);
    should([...config.CONFIG_SCHEMA_IDS]).deepEqual([
      'machine',
      'login',
      'component-instructions',
      'component-mcp',
      'component-skills',
      'component-settings',
      'component-hooks',
      'component-modelSets',
      'profile',
      'runtime',
      'warden',
      'learning',
      'voice',
      'pack',
      'modelsGuide',
      'preset',
      'models',
    ]);
    should(FILES.map(file => file.schema).toSorted()).deepEqual([...config.CONFIG_SCHEMA_IDS].toSorted());
  });

  it('should keep a schema file under the config directory, beside no configuration file', () => {
    // Act
    const actual = config.configSchemaPath('component-mcp');

    // Assert
    should(actual).equal('.schema/component-mcp.json');
    should(config.classifyConfigPath(actual)).be.undefined();
  });

  it.each([
    ['machine.yaml', '# yaml-language-server: $schema=.schema/machine.json'],
    ['logins/claude-you.yaml', '# yaml-language-server: $schema=../.schema/login.json'],
    ['profiles/default.yaml', '# yaml-language-server: $schema=../.schema/profile.json'],
    ['components/mcp/github.yaml', '# yaml-language-server: $schema=../../.schema/component-mcp.json'],
  ])('should point %s at its own schema, relative to the file', (path, expected) => {
    // Arrange
    const address = config.classifyConfigPath(path) as Address;

    // Act
    const actual = config.configSchemaModeline(address);

    // Assert
    should(actual).equal(expected);
  });

  it('should have a modeline depth equal to how many directories the file is below the config root', () => {
    // Act + Assert
    for (const file of FILES) {
      const depth = file.path.split('/').length - 1;
      should(config.configSchemaModeline(file.address)).equal(
        `# yaml-language-server: $schema=${'../'.repeat(depth)}.schema/${file.schema}.json`,
      );
    }
  });

  it('should leave only Warden settings to the warden capability and give everything else to fleet', () => {
    // Act + Assert
    for (const file of FILES) {
      should(config.configFileCapability(file.address)).equal(file.address.kind === 'warden' ? 'warden' : 'fleet');
    }
  });
});

describe('warden.yaml', () => {
  it('should mean the defaults when the file says nothing', () => {
    // Act
    const actual = config.wardenConfigFromFile(config.WardenFileSchema.parse({}));

    // Assert
    should(actual).deepEqual(config.DEFAULT_WARDEN_CONFIG);
    should(actual.layers).deepEqual({ jev: false, llm: false });
    should(actual.mayActAlone.stop).be.false();
  });

  it('should override a top-level setting and keep every other default', () => {
    // Arrange
    const input = config.WardenFileSchema.parse({ enabled: true, intervalMinutes: 10 });

    // Act
    const actual = config.wardenConfigFromFile(input);

    // Assert
    should(actual).deepEqual({ ...config.DEFAULT_WARDEN_CONFIG, enabled: true, intervalMinutes: 10 });
  });

  it('should merge a partial failover and a partial providerOutage into their defaults, key by key', () => {
    // Arrange
    const input = config.WardenFileSchema.parse({
      failover: { policy: 'round_robin' },
      providerOutage: { tailLines: 50 },
    });

    // Act
    const actual = config.wardenConfigFromFile(input);

    // Assert
    should(actual.failover).deepEqual({ ...config.DEFAULT_WARDEN_CONFIG.failover, policy: 'round_robin' });
    should(actual.providerOutage).deepEqual({ ...config.DEFAULT_WARDEN_CONFIG.providerOutage, tailLines: 50 });
  });

  it('should merge the Jev guard, caps, may-act-alone and event sections key by key', () => {
    // Arrange
    const input = config.WardenFileSchema.parse({
      triage: 'jev',
      guard: { threshold: 0.9 },
      caps: { jevUsdPerDay: 1 },
      mayActAlone: { nudge: false },
      events: { turnEnd: false },
      investigation: { effort: 'high' },
    });

    // Act
    const actual = config.wardenConfigFromFile(input);

    // Assert
    should(actual.guard).deepEqual({ ...config.DEFAULT_WARDEN_CONFIG.guard, threshold: 0.9 });
    should(actual.caps).deepEqual({ ...config.DEFAULT_WARDEN_CONFIG.caps, jevUsdPerDay: 1 });
    should(actual.mayActAlone).deepEqual({ ...config.DEFAULT_WARDEN_CONFIG.mayActAlone, nudge: false });
    should(actual.events).deepEqual({ ...config.DEFAULT_WARDEN_CONFIG.events, turnEnd: false });
    should(actual.investigation).deepEqual({ effort: 'high' });
  });

  it('should merge a partial revive section into its defaults, key by key', () => {
    // Arrange
    const input = config.WardenFileSchema.parse({ revive: { enabled: false, waveSize: 2 } });

    // Act
    const actual = config.wardenConfigFromFile(input);

    // Assert
    should(actual.revive).deepEqual({ ...config.DEFAULT_WARDEN_CONFIG.revive, enabled: false, waveSize: 2 });
    should(actual.revive.windowMinutes).equal(15);
  });

  it.each([
    ['a wave larger than three', { waveSize: 4 }],
    ['a wave gap under ten seconds', { waveGapSeconds: 5 }],
    ['an unknown key', { oom: true }],
  ])('should reject %s in the revive section', (_name, revive) => {
    // Act
    const parsed = config.WardenFileSchema.safeParse({ revive });

    // Assert
    should(parsed.success).be.false();
  });

  it('should read a legacy triage as its layers, with an explicit layer winning', () => {
    // Arrange
    const input = config.WardenFileSchema.parse({ triage: 'jev', layers: { llm: false } });

    // Act
    const actual = config.wardenConfigFromFile(input);

    // Assert
    should(actual.layers).deepEqual({ jev: true, llm: false });
    should(actual).not.have.property('triage');
  });

  it('should replace the account list whole rather than merging it into the default one', () => {
    // Arrange
    const input = config.WardenFileSchema.parse({ accounts: [{ agent: 'claude-work', model: 'm' }] });

    // Act
    const actual = config.wardenConfigFromFile(input);

    // Assert
    should(actual.accounts).deepEqual([{ agent: 'claude-work', model: 'm' }]);
  });

  it.each([
    ['an unknown key', { warden: true }],
    ['an unknown key inside failover', { failover: { policy: 'fallback', extra: 1 } }],
    ['an unknown key inside an account', { accounts: [{ agent: 'a', extra: 1 }] }],
    ['an account with no name', { accounts: [{ agent: '' }] }],
    ['an interval of zero', { intervalMinutes: 0 }],
    ['a negative gap', { minSpawnGapMinutes: -1 }],
    ['a distinct-session floor below two', { providerOutage: { minDistinctSessions: 1 } }],
    ['a non-boolean enabled', { enabled: 'yes' }],
    ['an interval nobody can pick', { intervalMinutes: 7 }],
    ['an unknown triage', { triage: 'ai' }],
    ['an unknown layer', { layers: { rules: true } }],
    ['an unknown key inside caps', { caps: { usd: 1 } }],
    ['a threshold below the floor', { guard: { threshold: 0.29 } }],
  ])('should refuse %s', (_label, input) => {
    // Act
    const actual = config.WardenFileSchema.safeParse(input);

    // Assert
    should(actual.success).be.false();
  });

  it('should accept an empty failover order, which hands the login to the machine default', () => {
    // Act
    const actual = config.WardenFileSchema.safeParse({ accounts: [] });

    // Assert
    should(actual.success).be.true();
    should(config.DEFAULT_WARDEN_CONFIG.accounts).deepEqual([]);
  });

  it('should accept a gap of zero, which turns the spacing off', () => {
    // Act
    const actual = config.WardenFileSchema.safeParse({ minSpawnGapMinutes: 0, assignedCooldownMinutes: 0 });

    // Assert
    should(actual.success).be.true();
  });
});

describe('learning.yaml', () => {
  it('should mean the defaults when the file says nothing', () => {
    // Act
    const actual = config.learningConfigFromFile(config.LearningFileSchema.parse({}));

    // Assert
    should(actual).deepEqual(config.DEFAULT_LEARNING_CONFIG);
    should(actual.enabled).be.true();
  });

  it('should override what the file sets and keep every other default', () => {
    // Arrange
    const input = config.LearningFileSchema.parse({ enabled: false, batchSize: 5, model: 'small' });

    // Act
    const actual = config.learningConfigFromFile(input);

    // Assert
    should(actual).deepEqual({ ...config.DEFAULT_LEARNING_CONFIG, enabled: false, batchSize: 5, model: 'small' });
  });

  it.each([
    ['an unknown key', { lessons: true }],
    ['a batch of zero', { batchSize: 0 }],
    ['an empty agent', { agent: '' }],
    ['a negative gap', { minSpawnGapMinutes: -5 }],
  ])('should refuse %s', (_label, input) => {
    // Act
    const actual = config.LearningFileSchema.safeParse(input);

    // Assert
    should(actual.success).be.false();
  });
});

describe('voice.yaml', () => {
  it('should mean no post-processing when the file is empty', () => {
    // Act
    const actual = config.VoiceConfigSchema.parse({});

    // Assert
    should(actual).deepEqual({
      postProcessing: { provider: 'off', style: 'fix', prompts: {}, useConversation: false, conversationMessages: 8 },
    });
    should(config.DEFAULT_VOICE_CONFIG).deepEqual(actual);
  });

  it('should list every post-processor, off first', () => {
    // Assert
    should([...config.VOICE_POST_PROCESSORS]).deepEqual(['off', 'groq', 'cerebras', 'login']);
  });

  it.each([
    ['a hosted provider alone', { postProcessing: { provider: 'groq' } }],
    ['a hosted provider with a model', { postProcessing: { provider: 'cerebras', model: 'llama' } }],
    ['a login naming its login', { postProcessing: { provider: 'login', login: 'claude-you' } }],
    ['a login naming its login and model', { postProcessing: { provider: 'login', login: 'claude-you', model: 'm' } }],
    ['off with nothing else', { postProcessing: { provider: 'off' } }],
  ])('should accept %s', (_label, input) => {
    // Act
    const actual = config.VoiceConfigSchema.safeParse(input);

    // Assert
    should(actual.success).be.true();
  });

  it.each([
    ['a style', { postProcessing: { style: 'polish' } }, true],
    ['off as a style', { postProcessing: { style: 'off' } }, true],
    ['an unknown style', { postProcessing: { style: 'shout' } }, false],
    ['both prompts', { postProcessing: { prompts: { fix: 'Fix it.', polish: 'Polish it.' } } }, true],
    ['a blank prompt', { postProcessing: { prompts: { fix: '   ' } } }, false],
    ['an unknown prompt', { postProcessing: { prompts: { shout: 'hi' } } }, false],
    ['a prompt over the cap', { postProcessing: { prompts: { fix: 'a'.repeat(2_001) } } }, false],
    ['ten conversation messages', { postProcessing: { useConversation: true, conversationMessages: 10 } }, true],
    ['eleven conversation messages', { postProcessing: { conversationMessages: 11 } }, false],
    ['zero conversation messages', { postProcessing: { conversationMessages: 0 } }, false],
  ])('should judge %s', (_label, input, accepted) => {
    // Act
    const actual = config.VoiceConfigSchema.safeParse(input);

    // Assert
    should(actual.success).equal(accepted);
  });

  it('should ship a default prompt for each style a person can rewrite', () => {
    // Assert
    should(Object.keys(config.DEFAULT_VOICE_CLEANUP_PROMPTS)).deepEqual(['fix', 'polish']);
    should([...config.VOICE_CLEANUP_STYLES]).deepEqual(['off', 'fix', 'polish']);
  });

  it('should name the two speech engines a machine can default to', () => {
    // Assert
    should([...config.VOICE_ENGINES]).deepEqual(['parakeet', 'browser']);
  });

  it.each(['parakeet', 'browser'])('should accept defaultEngine %s and keep it', engine => {
    // Act
    const actual = config.VoiceConfigSchema.safeParse({ defaultEngine: engine });

    // Assert
    should(actual.success).be.true();
    should(actual.data?.defaultEngine).equal(engine);
  });

  it('should leave defaultEngine unset when the file names none', () => {
    // Act
    const actual = config.VoiceConfigSchema.parse({ postProcessing: { provider: 'off' } });

    // Assert
    should(actual.defaultEngine).be.undefined();
  });

  it.each(['whisper', '', 'Parakeet'])('should refuse defaultEngine %p', engine => {
    // Act
    const actual = config.VoiceConfigSchema.safeParse({ defaultEngine: engine });

    // Assert
    should(actual.success).be.false();
  });

  it('should refuse provider login with no login, naming the missing key', () => {
    // Act
    const actual = config.VoiceConfigSchema.safeParse({ postProcessing: { provider: 'login' } });

    // Assert
    should(actual.success).be.false();
    const issue = actual.error?.issues[0];
    should(issue?.path).deepEqual(['postProcessing', 'login']);
    should(issue?.message).match(/provider: login needs "login"/u);
  });

  it.each(['off', 'groq', 'cerebras'])('should refuse a login beside provider %s, naming the provider', provider => {
    // Act
    const actual = config.VoiceConfigSchema.safeParse({ postProcessing: { provider, login: 'claude-you' } });

    // Assert
    should(actual.success).be.false();
    const issue = actual.error?.issues[0];
    should(issue?.path).deepEqual(['postProcessing', 'login']);
    should(issue?.message).equal(`"login" is only read with provider: login — this one is provider: ${provider}`);
  });

  it.each([
    ['an unknown provider', { postProcessing: { provider: 'openai' } }],
    ['an unknown key', { postProcessing: { provider: 'off' }, transcription: 'cloud' }],
    ['an unknown key in postProcessing', { postProcessing: { provider: 'off', temperature: 1 } }],
    ['an empty login', { postProcessing: { provider: 'login', login: '' } }],
    ['an empty model', { postProcessing: { provider: 'groq', model: '' } }],
  ])('should refuse %s', (_label, input) => {
    // Act
    const actual = config.VoiceConfigSchema.safeParse(input);

    // Assert
    should(actual.success).be.false();
  });
});

const issue = {
  path: 'warden.yaml',
  line: 3,
  column: 1,
  severity: 'error',
  message: 'enabled: expected boolean',
  fix: 'change enabled',
};

const summary = { path: 'warden.yaml', kind: 'warden', schema: 'warden', state: 'pending' };
const pending = { path: 'warden.yaml', etag: 'abc123', changes: ['the Warden may now spend on AI investigations'] };

const cases: SchemaCase[] = [
  { name: 'ConfigComponentKindSchema', schema: config.ConfigComponentKindSchema, value: 'modelSets' },
  { name: 'ConfigFileKindSchema', schema: config.ConfigFileKindSchema, value: 'component' },
  { name: 'ConfigSchemaIdSchema', schema: config.ConfigSchemaIdSchema, value: 'component-hooks' },
  { name: 'VoicePostProcessorSchema', schema: config.VoicePostProcessorSchema, value: 'login' },
  {
    name: 'WardenFileSchema',
    schema: config.WardenFileSchema,
    value: { enabled: true, failover: { cooldownMinutes: 5 } },
  },
  { name: 'LearningFileSchema', schema: config.LearningFileSchema, value: { batchSize: 3 } },
  { name: 'VoiceEngineSchema', schema: config.VoiceEngineSchema, value: 'parakeet' },
  { name: 'VoiceCleanupStyleSchema', schema: config.VoiceCleanupStyleSchema, value: 'polish' },
  { name: 'VoiceCleanupPromptsSchema', schema: config.VoiceCleanupPromptsSchema, value: { fix: 'Fix it.' } },
  { name: 'VoiceConfigSchema', schema: config.VoiceConfigSchema, value: { postProcessing: { provider: 'groq' } } },
  {
    name: 'VoiceConfigSchema with a default engine',
    schema: config.VoiceConfigSchema,
    value: { defaultEngine: 'browser', postProcessing: { provider: 'off' } },
  },
  { name: 'ConfigIssueSeveritySchema', schema: config.ConfigIssueSeveritySchema, value: 'warning' },
  { name: 'ConfigIssueSchema', schema: config.ConfigIssueSchema, value: issue },
  {
    name: 'ConfigIssueSchema without a position',
    schema: config.ConfigIssueSchema,
    value: { path: 'machine.yaml', severity: 'warning', message: 'm', fix: 'f' },
  },
  { name: 'ConfigPendingSchema', schema: config.ConfigPendingSchema, value: pending },
  { name: 'ConfigFileStateSchema', schema: config.ConfigFileStateSchema, value: 'invalid' },
  { name: 'ConfigFileSummarySchema', schema: config.ConfigFileSummarySchema, value: summary },
  {
    name: 'ConfigStatusViewSchema',
    schema: config.ConfigStatusViewSchema,
    value: { directory: '/state/config', files: [summary], issues: [issue], pending: [pending], checkedAt: INSTANT },
  },
  { name: 'ConfigFilePathSchema', schema: config.ConfigFilePathSchema, value: 'components/mcp/github.yaml' },
  {
    name: 'ConfigFileViewSchema',
    schema: config.ConfigFileViewSchema,
    value: {
      path: 'warden.yaml',
      absolutePath: '/state/config/warden.yaml',
      kind: 'warden',
      schema: 'warden',
      exists: false,
      text: '# starter\n',
      etag: 'absent',
      state: 'ok',
      issues: [],
    },
  },
  {
    name: 'ConfigFilePutRequestSchema',
    schema: config.ConfigFilePutRequestSchema,
    value: { path: 'warden.yaml', text: 'enabled: true\n' },
  },
  {
    name: 'ConfigFilePutResultSchema',
    schema: config.ConfigFilePutResultSchema,
    value: { path: 'warden.yaml', etag: 'abc', outcome: 'pending', pending },
  },
  {
    name: 'ConfigFilePutResultSchema applied',
    schema: config.ConfigFilePutResultSchema,
    value: { path: 'warden.yaml', etag: 'abc', outcome: 'applied' },
  },
  {
    name: 'ConfigConfirmRequestSchema',
    schema: config.ConfigConfirmRequestSchema,
    value: { path: 'machine.yaml', etag: 'abc' },
  },
  {
    name: 'ConfigConfirmResultSchema',
    schema: config.ConfigConfirmResultSchema,
    value: { path: 'machine.yaml', confirmed: true },
  },
  {
    name: 'ConfigInvalidBodySchema',
    schema: config.ConfigInvalidBodySchema,
    value: { error: 'invalid', code: config.CONFIG_INVALID_CODE, issues: [issue], requestId: 'extra-keys-are-loose' },
  },
  {
    name: 'AgentConfigToolCallSchema read all',
    schema: config.AgentConfigToolCallSchema,
    value: { tool: 'config.read' },
  },
  {
    name: 'AgentConfigToolCallSchema read one',
    schema: config.AgentConfigToolCallSchema,
    value: { tool: 'config.read', path: 'machine.yaml' },
  },
  {
    name: 'AgentConfigToolCallSchema validate',
    schema: config.AgentConfigToolCallSchema,
    value: { tool: 'config.validate', path: 'machine.yaml', text: 'agentPermissions: auto\n' },
  },
  {
    name: 'AgentConfigToolCallSchema write',
    schema: config.AgentConfigToolCallSchema,
    value: { tool: 'config.write', path: 'machine.yaml', text: 'agentPermissions: auto\n', etag: 'abc' },
  },
  {
    name: 'AgentConfigToolResultSchema',
    schema: config.AgentConfigToolResultSchema,
    value: { summary: 'Checked.', text: 'a: 1\n', etag: 'abc', issues: [issue], files: [summary] },
  },
  { name: 'AgentConfigToolResultSchema minimal', schema: config.AgentConfigToolResultSchema, value: { summary: 'ok' } },
];

describe('the configuration-file wire contract', () => {
  it('should round-trip every shape and cover every exported schema', () => {
    // Act & Assert
    assertRoundTrips(cases);
    assertCoversEverySchema(config, cases);
  });

  it('should pin the wire constants the editors agree on', () => {
    // Assert
    should(config.CONFIG_DIRECTORY_NAME).equal('config');
    should(config.CONFIG_SCHEMA_DIRECTORY).equal('.schema');
    should(config.CONFIG_FILE_EXTENSION).equal('.yaml');
    should(config.CONFIG_COMPONENTS_DIRECTORY).equal('components');
    should(config.CONFIG_IF_MATCH_HEADER).equal('if-match');
    should(config.CONFIG_INVALID_CODE).equal('config_invalid');
    should(config.CONFIG_FILE_MAX_BYTES).equal(262_144);
  });

  it.each([
    ['a .yml file', 'machine.yml'],
    ['an unknown file', 'notes.yaml'],
    ['a hidden file', 'profiles/.hidden.yaml'],
    ['a traversal', '../machine.yaml'],
    ['an empty path', ''],
  ])('should refuse %s as a path, saying which files exist', (_label, input) => {
    // Act
    const actual = config.ConfigFilePathSchema.safeParse(input);

    // Assert
    should(actual.success).be.false();
    if (!actual.success && input !== '') {
      should(actual.error.issues[0]?.message).match(/not a Ferretry configuration file — use machine\.yaml/u);
    }
  });

  it('should refuse a file written over the wire when its path is not a Ferretry file', () => {
    // Act
    const actual = config.ConfigFilePutRequestSchema.safeParse({ path: 'notes.yaml', text: 'a: 1\n' });

    // Assert
    should(actual.success).be.false();
  });

  it('should accept a text of exactly the size limit and refuse one byte more', () => {
    // Arrange
    const atLimit = 'a'.repeat(config.CONFIG_FILE_MAX_BYTES);

    // Act
    const accepted = config.ConfigFilePutRequestSchema.safeParse({ path: 'machine.yaml', text: atLimit });
    const refused = config.ConfigFilePutRequestSchema.safeParse({ path: 'machine.yaml', text: `${atLimit}a` });

    // Assert
    should(accepted.success).be.true();
    should(refused.success).be.false();
    should(refused.error?.issues[0]?.message).equal('a configuration file is at most 256 KiB');
  });

  it('should measure the size limit in bytes, not characters', () => {
    // Arrange — 3 bytes per character, so the byte count passes the limit long before the length does.
    const wide = '€'.repeat(Math.floor(config.CONFIG_FILE_MAX_BYTES / 3) + 1);

    // Act
    const actual = config.ConfigFilePutRequestSchema.safeParse({ path: 'machine.yaml', text: wide });

    // Assert
    should(wide.length).be.below(config.CONFIG_FILE_MAX_BYTES);
    should(actual.success).be.false();
  });

  it.each([
    ['an unknown tool', { tool: 'config.delete', path: 'machine.yaml' }],
    ['a read of a path that is not a file', { tool: 'config.read', path: 'notes.yaml' }],
    ['a validate with no text', { tool: 'config.validate', path: 'machine.yaml' }],
    ['a validate with no path', { tool: 'config.validate', text: 'a: 1\n' }],
    ['a write with an empty etag', { tool: 'config.write', path: 'machine.yaml', text: '', etag: '' }],
    ['a write of an oversized text', { tool: 'config.write', path: 'machine.yaml', text: 'a'.repeat(262_145) }],
    ['a read carrying text', { tool: 'config.read', text: 'a: 1\n' }],
    ['a write carrying an unknown key', { tool: 'config.write', path: 'machine.yaml', text: '', force: true }],
  ])('should refuse an agent tool call that is %s', (_label, input) => {
    // Act
    const actual = config.AgentConfigToolCallSchema.safeParse(input);

    // Assert
    should(actual.success).be.false();
  });

  it('should refuse the wire shapes that would carry more than the contract names', () => {
    // Arrange / Act / Assert
    assertRejects([
      { name: 'an issue with an empty fix', schema: config.ConfigIssueSchema, value: { ...issue, fix: '' } },
      { name: 'an issue at line zero', schema: config.ConfigIssueSchema, value: { ...issue, line: 0 } },
      {
        name: 'an issue carrying the value',
        schema: config.ConfigIssueSchema,
        value: { ...issue, value: 'sk-secret' },
      },
      {
        name: 'a pending edit with no changes',
        schema: config.ConfigPendingSchema,
        value: { ...pending, changes: [] },
      },
      {
        name: 'a file in an unknown state',
        schema: config.ConfigFileSummarySchema,
        value: { ...summary, state: 'gone' },
      },
      {
        name: 'an invalid body under another code',
        schema: config.ConfigInvalidBodySchema,
        value: { error: 'x', code: 'other', issues: [] },
      },
      {
        name: 'a confirmation of a path that is not a file',
        schema: config.ConfigConfirmRequestSchema,
        value: { path: 'notes.yaml', etag: 'abc' },
      },
      {
        name: 'a put result with an unknown outcome',
        schema: config.ConfigFilePutResultSchema,
        value: { path: 'machine.yaml', etag: 'abc', outcome: 'maybe' },
      },
    ]);
  });
});
