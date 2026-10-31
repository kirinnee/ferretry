import { describe, it } from 'bun:test';
import {
  CONFIG_COMPONENT_KINDS,
  CONFIG_SCHEMA_IDS,
  type ConfigFileAddress,
  type ConfigSchemaId,
  configSchemaModeline,
  DEFAULT_LEARNING_CONFIG,
  DEFAULT_PACK_CONFIG,
  DEFAULT_VOICE_CONFIG,
  DEFAULT_WARDEN_CONFIG,
  type LearningConfig,
  type PackConfig,
  type PackFile,
  packConfigFromFile,
  type VoiceConfig,
  VoiceConfigSchema,
  type WardenConfig,
} from '@ferretry/protocol';
import should from 'should';
import { checkConfigFile } from '../../../src/lib/config-files/check.ts';
import {
  CONFIG_FILE_SCHEMAS,
  CONFIG_FILE_STARTERS,
  configFileBody,
  configLoosening,
  configValue,
  type MachineFileValue,
  SINGLETON_DEFAULTS,
} from '../../../src/lib/config-files/kinds.ts';

const machineWith = (
  machine: Omit<Partial<MachineFileValue['machine']>, 'agentControl'> & {
    agentControl?: Partial<MachineFileValue['machine']['agentControl']>;
  },
): MachineFileValue => ({
  advanced: SINGLETON_DEFAULTS.machine.advanced,
  machine: {
    ...SINGLETON_DEFAULTS.machine.machine,
    ...machine,
    agentControl: { ...SINGLETON_DEFAULTS.machine.machine.agentControl, ...machine.agentControl },
  },
});

describe('SINGLETON_DEFAULTS', () => {
  it('should mean what a machine with no file behaves as', () => {
    // Assert
    should(SINGLETON_DEFAULTS.machine.machine).deepEqual({
      agentPermissions: 'auto',
      agentControl: { terminals: true, browsers: true, files: true, ferretrySettings: false, pageScripts: false },
      browserMode: 'headless',
      autoResume: true,
      agendaMode: true,
      attentionNudge: true,
      conversations: { listComputer: true },
    });
    should(SINGLETON_DEFAULTS.warden).equal(DEFAULT_WARDEN_CONFIG);
    should(SINGLETON_DEFAULTS.learning).equal(DEFAULT_LEARNING_CONFIG);
    should(SINGLETON_DEFAULTS.voice).equal(DEFAULT_VOICE_CONFIG);
  });

  it('should switch agents off Ferretry settings by default, since that switch is the kill switch', () => {
    should(SINGLETON_DEFAULTS.machine.machine.agentControl.ferretrySettings).be.false();
  });
});

describe('configValue', () => {
  it('should split machine.yaml into the account model machine and advanced', () => {
    // Arrange
    const input = {
      agentPermissions: 'skip',
      agentControl: { ferretrySettings: true, pageScripts: false },
      advanced: { aliases: {} },
    };

    // Act
    const parsed = CONFIG_FILE_SCHEMAS.machine.parse(input);
    const actual = configValue('machine', parsed) as MachineFileValue;

    // Assert
    should(actual.machine.agentPermissions).equal('skip');
    should(actual.machine.agentControl.ferretrySettings).be.true();
    should(actual.machine.agentControl.terminals).be.true();
    should(actual).not.have.property('machine.advanced');
    should(Object.keys(actual).toSorted()).deepEqual(['advanced', 'machine']);
    should(actual.advanced.commands).deepEqual([]);
  });

  it('should call a profile file’s contents the model’s layers', () => {
    // Arrange
    const parsed = CONFIG_FILE_SCHEMAS.profile.parse({ contents: ['instructions/main', 'profile/base'] });

    // Act
    const actual = configValue('profile', parsed);

    // Assert
    should(actual).deepEqual({ layers: ['instructions/main', 'profile/base'] });
  });

  it('should fill a profile with no contents as an empty stack', () => {
    // Act
    const actual = configValue('profile', CONFIG_FILE_SCHEMAS.profile.parse({}));

    // Assert
    should(actual).deepEqual({ layers: [] });
  });

  it('should fill every setting warden.yaml leaves out from the Warden defaults', () => {
    // Arrange
    const parsed = CONFIG_FILE_SCHEMAS.warden.parse({ enabled: true, failover: { cooldownMinutes: 5 } });

    // Act
    const actual = configValue('warden', parsed) as WardenConfig;

    // Assert
    should(actual.enabled).be.true();
    should(actual.failover).deepEqual({ ...DEFAULT_WARDEN_CONFIG.failover, cooldownMinutes: 5 });
    should(actual.intervalMinutes).equal(DEFAULT_WARDEN_CONFIG.intervalMinutes);
  });

  it('should fill every setting learning.yaml leaves out from the Learning defaults', () => {
    // Arrange
    const parsed = CONFIG_FILE_SCHEMAS.learning.parse({ batchSize: 3 });

    // Act
    const actual = configValue('learning', parsed) as LearningConfig;

    // Assert
    should(actual).deepEqual({ ...DEFAULT_LEARNING_CONFIG, batchSize: 3 });
  });

  it.each([
    ['login', { harness: 'claude', store: 'host' }],
    ['voice', { postProcessing: { provider: 'groq' } }],
    ['runtime', { credential: 'you', profile: 'default', agent: false }],
    ['component-mcp', { command: 'npx' }],
  ] as const)('should hand a %s file’s parsed value over as it is', (schema, input) => {
    // Arrange
    const parsed = CONFIG_FILE_SCHEMAS[schema].parse(input);

    // Act
    const actual = configValue(schema, parsed);

    // Assert
    should(actual).equal(parsed);
  });
});

describe('configFileBody', () => {
  it('should write the machine and its advanced block side by side', () => {
    // Arrange
    const input = machineWith({ agentPermissions: 'skip' });

    // Act
    const actual = configFileBody('machine', input) as Record<string, unknown>;

    // Assert
    should(actual.agentPermissions).equal('skip');
    should(actual.advanced).equal(input.advanced);
    should(Object.keys(actual)).containEql('agentControl');
  });

  it('should write a profile’s layers as its contents', () => {
    // Act
    const actual = configFileBody('profile', { layers: ['instructions/main'] });

    // Assert
    should(actual).deepEqual({ contents: ['instructions/main'] });
  });

  it('should round-trip a profile through its file schema', () => {
    // Arrange
    const input = { layers: ['mcp/github', 'profile/base'] } as const;

    // Act
    const actual = configValue('profile', CONFIG_FILE_SCHEMAS.profile.parse(configFileBody('profile', input)));

    // Assert
    should(actual).deepEqual(input);
  });

  it.each([
    ['warden', DEFAULT_WARDEN_CONFIG],
    ['learning', DEFAULT_LEARNING_CONFIG],
    ['voice', DEFAULT_VOICE_CONFIG],
  ] as const)('should write a %s value as it is', (schema, value) => {
    // Act + Assert
    should(configFileBody(schema, value)).equal(value);
  });

  it('should round-trip the machine defaults through machine.yaml', () => {
    // Act
    const actual = configValue(
      'machine',
      CONFIG_FILE_SCHEMAS.machine.parse(configFileBody('machine', SINGLETON_DEFAULTS.machine)),
    );

    // Assert
    should(actual).deepEqual(SINGLETON_DEFAULTS.machine);
  });
});

describe('configLoosening: machine', () => {
  it.each([
    ['terminals', 'agents may now control terminals'],
    ['browsers', 'agents may now control browsers'],
    ['files', 'agents may now control project files'],
    ['ferretrySettings', 'agents may now control Ferretry settings'],
    ['pageScripts', 'agents may now control page scripts'],
  ] as const)('should hold switching %s on, in a sentence naming it', (kind, expected) => {
    // Arrange
    const before = machineWith({
      agentControl: { terminals: false, browsers: false, files: false, ferretrySettings: false, pageScripts: false },
    });
    const after = machineWith({
      agentControl: { terminals: false, browsers: false, files: false, ferretrySettings: false, [kind]: true },
    });

    // Act
    const actual = configLoosening('machine', before, after);

    // Assert
    should(actual).deepEqual([expected]);
  });

  it('should hold Ferretry settings going on from the default, which is off', () => {
    // Act
    const actual = configLoosening(
      'machine',
      SINGLETON_DEFAULTS.machine,
      machineWith({ agentControl: { ferretrySettings: true, pageScripts: false } }),
    );

    // Assert
    should(actual).deepEqual(['agents may now control Ferretry settings']);
  });

  it('should hold Page scripts going on from the default, and apply it going off at once', () => {
    // Arrange
    const on = machineWith({ agentControl: { pageScripts: true } });

    // Act
    const goingOn = configLoosening('machine', SINGLETON_DEFAULTS.machine, on);
    const goingOff = configLoosening('machine', on, SINGLETON_DEFAULTS.machine);

    // Assert — an agent's own script can read what a page holds, so only the owner may turn it on.
    should(SINGLETON_DEFAULTS.machine.machine.agentControl.pageScripts).be.false();
    should(goingOn).deepEqual(['agents may now control page scripts']);
    should(goingOff).deepEqual([]);
  });

  it('should say every switch that went on, in one list', () => {
    // Arrange
    const before = machineWith({ agentControl: { terminals: false, browsers: false } });
    const after = machineWith({
      agentControl: { terminals: true, browsers: true, ferretrySettings: true, pageScripts: false },
    });

    // Act
    const actual = configLoosening('machine', before, after);

    // Assert
    should(actual).deepEqual([
      'agents may now control terminals',
      'agents may now control browsers',
      'agents may now control Ferretry settings',
    ]);
  });

  it('should hold agents skipping permission prompts', () => {
    // Act
    const actual = configLoosening('machine', machineWith({}), machineWith({ agentPermissions: 'skip' }));

    // Assert
    should(actual).deepEqual(['agents now skip every permission prompt']);
  });

  it('should apply tightening at once: switches going off and prompts returning loosen nothing', () => {
    // Arrange
    const loose = machineWith({
      agentPermissions: 'skip',
      agentControl: { ferretrySettings: true, pageScripts: false },
    });
    const tight = machineWith({
      agentPermissions: 'auto',
      agentControl: { terminals: false, browsers: false, files: false, ferretrySettings: false, pageScripts: false },
    });

    // Act
    const actual = configLoosening('machine', loose, tight);

    // Assert
    should(actual).deepEqual([]);
  });

  it('should not hold a switch that stays on, or a machine left as it was', () => {
    // Act + Assert
    should(configLoosening('machine', SINGLETON_DEFAULTS.machine, SINGLETON_DEFAULTS.machine)).deepEqual([]);
    should(
      configLoosening('machine', machineWith({ agentPermissions: 'skip' }), machineWith({ agentPermissions: 'skip' })),
    ).deepEqual([]);
  });
});

describe('configLoosening: browser proxy', () => {
  const proxy = { url: 'http://proxy.example:8080', bypass: [] as string[] };
  const signedIn = { ...proxy, username: '${secret:PROXY_USER}', password: '${secret:PROXY_PASSWORD}' };

  it("should hold a proxy that is newly set: it could send a stored secret to a server of an editor's choosing", () => {
    // Act
    const actual = configLoosening('machine', machineWith({}), machineWith({ browserProxy: signedIn }));

    // Assert
    should(actual).deepEqual([
      'the agent browser now sends its traffic through the proxy at http://proxy.example:8080',
    ]);
  });

  it('should hold a proxy whose address or credentials change', () => {
    // Act + Assert
    should(
      configLoosening(
        'machine',
        machineWith({ browserProxy: proxy }),
        machineWith({ browserProxy: { ...proxy, url: 'http://other.example:8080' } }),
      ),
    ).have.length(1);
    should(
      configLoosening(
        'machine',
        machineWith({ browserProxy: signedIn }),
        machineWith({ browserProxy: { ...signedIn, password: '${secret:OTHER}' } }),
      ),
    ).have.length(1);
    should(
      configLoosening('machine', machineWith({ browserProxy: proxy }), machineWith({ browserProxy: signedIn })),
    ).have.length(1);
  });

  it('should apply at once a proxy turned off or a bypass list edited, which hand over nothing new', () => {
    // Act + Assert
    should(configLoosening('machine', machineWith({ browserProxy: signedIn }), machineWith({}))).deepEqual([]);
    should(
      configLoosening(
        'machine',
        machineWith({ browserProxy: signedIn }),
        machineWith({ browserProxy: { ...signedIn, bypass: ['*.internal.example'] } }),
      ),
    ).deepEqual([]);
    should(
      configLoosening('machine', machineWith({ browserProxy: proxy }), machineWith({ browserProxy: proxy })),
    ).deepEqual([]);
  });
});

describe('configLoosening: warden', () => {
  const wardenWith = (changes: Partial<WardenConfig>): WardenConfig => ({ ...DEFAULT_WARDEN_CONFIG, ...changes });

  it.each([
    [{ layers: { jev: false, llm: true } }, ['the Warden may now spend on AI investigations']],
    [{ layers: { jev: true, llm: false } }, ['the Warden may now spend on Jev decisions']],
    [
      { layers: { jev: true, llm: true } },
      ['the Warden may now spend on Jev decisions', 'the Warden may now spend on AI investigations'],
    ],
    [
      { mayActAlone: { ...DEFAULT_WARDEN_CONFIG.mayActAlone, stop: true } },
      ['the Warden may now stop a ferret on its own'],
    ],
    [
      { caps: { ...DEFAULT_WARDEN_CONFIG.caps, jevUsdPerDay: 3 } },
      ['the daily Jev cap in dollars goes up from 0.5 to 3'],
    ],
    [
      { caps: { ...DEFAULT_WARDEN_CONFIG.caps, investigationUsdPerDay: 5 } },
      ['the daily investigation cap in dollars goes up from 2 to 5'],
    ],
    [
      { caps: { ...DEFAULT_WARDEN_CONFIG.caps, maxInvestigationsPerHour: 9 } },
      ['the investigations allowed per hour goes up from 6 to 9'],
    ],
    [
      { guard: { ...DEFAULT_WARDEN_CONFIG.guard, usdPerMillionInputTokens: 0.01 } },
      ['the Jev price the cap counts with goes down from 0.042 to 0.01'],
    ],
    [{ maxAssignedWardens: 3 }, ['the number of wardens that may run at once goes up from 1 to 3']],
    [{ intervalMinutes: 1 }, ['the minutes between Warden sweeps goes down from 2 to 1']],
    [{ minSpawnGapMinutes: 0 }, ['the minutes between two Warden investigations goes down from 15 to 0']],
    [
      { jevActs: { ...DEFAULT_WARDEN_CONFIG.jevActs, stop: 0.9 } },
      ['how sure Jev must be to stop a ferret on its own goes down from 0.98 to 0.9'],
    ],
    [
      { jevActs: { ...DEFAULT_WARDEN_CONFIG.jevActs, nudge: 0.85 } },
      ['how sure Jev must be to nudge a ferret on its own goes down from 0.9 to 0.85'],
    ],
  ] as const)('should hold %j, saying %j', (changes, expected) => {
    // Act
    const actual = configLoosening('warden', DEFAULT_WARDEN_CONFIG, wardenWith(changes));

    // Assert
    should(actual).deepEqual(expected);
  });

  it.each([
    [{ layers: { jev: false, llm: false } }, { layers: { jev: false, llm: true } }],
    [{ layers: { jev: true, llm: false } }, { layers: { jev: true, llm: true } }],
    [{ maxAssignedWardens: 1 }, { maxAssignedWardens: 3 }],
    [{ intervalMinutes: 2 }, { intervalMinutes: 1 }],
    [{ minSpawnGapMinutes: 15 }, { minSpawnGapMinutes: 0 }],
    [{ jevActs: { ...DEFAULT_WARDEN_CONFIG.jevActs, restart: 1 } }, { jevActs: DEFAULT_WARDEN_CONFIG.jevActs }],
  ] as const)('should apply the opposite edit (%j to %j) at once', (tighter, looser) => {
    // Act
    const actual = configLoosening('warden', wardenWith(looser), wardenWith(tighter));

    // Assert
    should(actual).deepEqual([]);
  });

  it('should hold letting the Warden restart a ferret on its own', () => {
    // Arrange
    const off = { ...DEFAULT_WARDEN_CONFIG.mayActAlone, restart: false };

    // Act
    const actual = configLoosening(
      'warden',
      wardenWith({ mayActAlone: off }),
      wardenWith({ mayActAlone: DEFAULT_WARDEN_CONFIG.mayActAlone }),
    );

    // Assert
    should(actual).deepEqual(['the Warden may now restart a ferret on its own']);
  });

  it('should hold turning the Warden on when a layer already spends, and not when both are off', () => {
    // Act
    const spending = configLoosening(
      'warden',
      wardenWith({ enabled: false, layers: { jev: false, llm: true } }),
      wardenWith({ enabled: true, layers: { jev: false, llm: true } }),
    );
    const free = configLoosening('warden', wardenWith({ enabled: false }), wardenWith({ enabled: true }));

    // Assert
    should(spending).deepEqual(['the Warden may now spend on AI investigations']);
    should(free).deepEqual([]);
  });

  it('should not hold a setting that does not spend: the accounts, thresholds and failover', () => {
    // Act
    const actual = configLoosening(
      'warden',
      DEFAULT_WARDEN_CONFIG,
      wardenWith({
        accounts: [{ agent: 'another' }],
        susThinkingSeconds: 1,
        blessMinutes: 0,
        assignedCooldownMinutes: 0,
      }),
    );

    // Assert
    should(actual).deepEqual([]);
  });
});

describe('configLoosening: learning', () => {
  const learningWith = (changes: Partial<LearningConfig>): LearningConfig => ({
    ...DEFAULT_LEARNING_CONFIG,
    ...changes,
  });
  const off = learningWith({ enabled: false });

  it('should hold lesson mining being switched on', () => {
    // Act
    const actual = configLoosening('learning', off, learningWith({ enabled: true }));

    // Assert
    should(actual).deepEqual(['lesson mining may now spend on agent sessions']);
  });

  it.each([
    [{ maxMinersPerRun: 5 }, ['the lesson miners one run may start goes up from 2 to 5']],
    [{ maxSessionsPerRun: 100 }, ['the sessions one lesson run may read goes up from 40 to 100']],
    [{ batchSize: 50 }, ['the sessions one lesson miner reads goes up from 20 to 50']],
    [{ intervalMinutes: 10 }, ['the minutes between lesson runs goes down from 60 to 10']],
    [{ minSpawnGapMinutes: 1 }, ['the minutes between two lesson miners goes down from 30 to 1']],
  ] as const)('should hold %j, saying %j', (changes, expected) => {
    // Act
    const actual = configLoosening('learning', DEFAULT_LEARNING_CONFIG, learningWith(changes));

    // Assert
    should(actual).deepEqual(expected);
  });

  it('should apply every cap coming down, and the schedule slowing, at once', () => {
    // Act
    const actual = configLoosening(
      'learning',
      DEFAULT_LEARNING_CONFIG,
      learningWith({
        enabled: false,
        maxMinersPerRun: 1,
        maxSessionsPerRun: 1,
        batchSize: 1,
        intervalMinutes: 600,
        minSpawnGapMinutes: 300,
      }),
    );

    // Assert
    should(actual).deepEqual([]);
  });

  it('should not hold changing which agent mines', () => {
    // Act
    const actual = configLoosening('learning', DEFAULT_LEARNING_CONFIG, learningWith({ agent: 'codex', model: 'm' }));

    // Assert
    should(actual).deepEqual([]);
  });
});

describe('configLoosening: voice', () => {
  const voiceWith = (postProcessing: Partial<VoiceConfig['postProcessing']>): VoiceConfig =>
    VoiceConfigSchema.parse({ postProcessing });

  it.each([
    [{ provider: 'groq' }, 'dictated text now goes to groq to be cleaned up'],
    [{ provider: 'cerebras' }, 'dictated text now goes to cerebras to be cleaned up'],
    [{ provider: 'login', login: 'work' }, 'dictated text now goes to the login work to be cleaned up'],
  ] as const)('should hold turning post-processing on as %j', (to, expected) => {
    // Act
    const actual = configLoosening('voice', DEFAULT_VOICE_CONFIG, voiceWith(to));

    // Assert
    should(actual).deepEqual([expected]);
  });

  it('should hold sending the text somewhere else', () => {
    // Act
    const actual = configLoosening('voice', voiceWith({ provider: 'groq' }), voiceWith({ provider: 'cerebras' }));

    // Assert
    should(actual).deepEqual(['dictated text now goes to cerebras to be cleaned up']);
  });

  it('should hold pointing the same login provider at another login', () => {
    // Act
    const actual = configLoosening(
      'voice',
      voiceWith({ provider: 'login', login: 'work' }),
      voiceWith({ provider: 'login', login: 'home' }),
    );

    // Assert
    should(actual).deepEqual(['dictated text now goes to the login home to be cleaned up']);
  });

  it('should name a login provider that holds no login without a stray space', () => {
    // Arrange — the schema refuses this shape; the rule must still say something sensible for it.
    const bare: VoiceConfig = { postProcessing: { ...DEFAULT_VOICE_CONFIG.postProcessing, provider: 'login' } };

    // Act
    const actual = configLoosening('voice', DEFAULT_VOICE_CONFIG, bare);

    // Assert
    should(actual).deepEqual(['dictated text now goes to the login to be cleaned up']);
  });

  it('should apply turning post-processing off at once', () => {
    // Act
    const actual = configLoosening('voice', voiceWith({ provider: 'groq' }), DEFAULT_VOICE_CONFIG);

    // Assert
    should(actual).deepEqual([]);
  });

  it('should not hold a change of model alone: the text goes where it already went', () => {
    // Act
    const actual = configLoosening(
      'voice',
      voiceWith({ provider: 'groq' }),
      voiceWith({ provider: 'groq', model: 'another-model' }),
    );

    // Assert
    should(actual).deepEqual([]);
  });

  it('should hold sharing the conversation with the provider', () => {
    // Act
    const actual = configLoosening(
      'voice',
      voiceWith({ provider: 'groq' }),
      voiceWith({ provider: 'groq', useConversation: true }),
    );

    // Assert
    should(actual).deepEqual([
      'recent conversation messages may now go to the cleanup provider to help clean up dictation',
    ]);
  });

  it('should apply sharing less of the conversation, or none, at once', () => {
    // Act
    const actual = configLoosening(
      'voice',
      voiceWith({ provider: 'groq', useConversation: true }),
      voiceWith({ provider: 'groq', useConversation: true, conversationMessages: 3 }),
    );

    // Assert
    should(actual).deepEqual([]);
  });

  it('should hold switching the cleanup style back on from off', () => {
    // Act
    const actual = configLoosening(
      'voice',
      voiceWith({ provider: 'groq', style: 'off' }),
      voiceWith({ provider: 'groq', style: 'polish' }),
    );

    // Assert
    should(actual).deepEqual(['dictated text now goes to groq to be cleaned up']);
  });

  it('should apply editing a prompt at once', () => {
    // Act
    const actual = configLoosening(
      'voice',
      voiceWith({ provider: 'groq' }),
      voiceWith({ provider: 'groq', prompts: { fix: 'Fix it.' } }),
    );

    // Assert
    should(actual).deepEqual([]);
  });

  it('should not hold off staying off', () => {
    // Act + Assert
    should(configLoosening('voice', DEFAULT_VOICE_CONFIG, DEFAULT_VOICE_CONFIG)).deepEqual([]);
  });
});

/** Where a starter of each schema id belongs, for a kind that has a name. */
const CANONICAL_PATHS: Readonly<Record<ConfigSchemaId, string>> = {
  machine: 'machine.yaml',
  login: 'logins/my-login.yaml',
  profile: 'profiles/my-profile.yaml',
  runtime: 'runtimes/my-runtime.yaml',
  warden: 'warden.yaml',
  learning: 'learning.yaml',
  voice: 'voice.yaml',
  pack: 'pack.yaml',
  modelsGuide: 'models-guide.yaml',
  preset: 'presets/my-preset.yaml',
  models: 'models/my-provider.yaml',
  ...Object.fromEntries(CONFIG_COMPONENT_KINDS.map(kind => [`component-${kind}`, `components/${kind}/main.yaml`])),
} as Record<ConfigSchemaId, string>;

describe('CONFIG_FILE_STARTERS', () => {
  it('should hold exactly one starter for every schema id', () => {
    // Assert
    should(Object.keys(CONFIG_FILE_STARTERS).toSorted()).deepEqual([...CONFIG_SCHEMA_IDS].toSorted());
    should(Object.keys(CONFIG_FILE_SCHEMAS).toSorted()).deepEqual([...CONFIG_SCHEMA_IDS].toSorted());
  });

  /** A starter checked exactly as a file at its kind's canonical path would be, modeline first. */
  const checkStarter = (id: ConfigSchemaId) => {
    const path = CANONICAL_PATHS[id];
    const address = checkConfigFile(path, 'x: 1').address as ConfigFileAddress;
    return checkConfigFile(path, `${configSchemaModeline(address)}\n${CONFIG_FILE_STARTERS[id]}`);
  };

  it.each([...CONFIG_SCHEMA_IDS])('should give a %s starter that passes its own check once it has its modeline', id => {
    // Act
    const actual = checkStarter(id);

    // Assert
    should(actual.issues).deepEqual([]);
    should(actual.ok).be.true();
  });

  it.each([...CONFIG_SCHEMA_IDS])('should give a %s starter that holds no secret value', id => {
    // Assert
    should(CONFIG_FILE_STARTERS[id]).not.match(/sk-|AKIA|ghp_|xox[abprs]-/u);
  });

  it('should show the login starter naming its secret as a reference, never a value', () => {
    // Assert
    should(CONFIG_FILE_STARTERS.login).containEql('${secret:EXAMPLE_API_KEY}');
  });
});

describe('configLoosening — pack.yaml and models-guide.yaml', () => {
  const pack = (file: PackFile): PackConfig => packConfigFromFile(file);

  it.each([
    [{ enabled: false }, {}, ['ferrets may now start sub-ferrets (Pack mode)']],
    [{}, { decision: 'jev' }, ['Jev may now spend on choosing sub-ferret models']],
    [
      { enabled: false, decision: 'jev' },
      { decision: 'jev' },
      ['ferrets may now start sub-ferrets (Pack mode)', 'Jev may now spend on choosing sub-ferret models'],
    ],
    [
      {},
      { limits: { interactiveChildren: 30 } },
      ['the sub-ferrets an interactive ferret may run at once goes up from 20 to 30'],
    ],
    [{}, { limits: { autoChildren: 8 } }, ['the sub-ferrets an unattended ferret may run at once goes up from 4 to 8']],
    [{}, { limits: { maxDepth: 3 } }, ['how deep sub-ferrets may nest goes up from 2 to 3']],
    [{}, { jev: { usdPerDay: 1 } }, ["Jev's daily cap in dollars for choosing models goes up from 0.25 to 1"]],
  ] as const)('should hold %j → %j, saying %j', (before, after, expected) => {
    // Act
    const actual = configLoosening('pack', pack(before as PackFile), pack(after as PackFile));

    // Assert
    should(actual).deepEqual(expected);
  });

  it('should apply at once everything that tightens or spends nothing more', () => {
    // Act
    const actual = configLoosening(
      'pack',
      DEFAULT_PACK_CONFIG,
      pack({
        enabled: false,
        limits: { interactiveChildren: 1, autoChildren: 0, maxDepth: 1 },
        probe: { timeoutSeconds: 300, cacheSeconds: 0 },
      }),
    );

    // Assert
    should(actual).deepEqual([]);
    should(
      configLoosening('pack', pack({ decision: 'jev', enabled: false }), pack({ decision: 'jev', enabled: false })),
    ).deepEqual([]);
  });

  it('should never hold a routing prompt: it widens nothing a ferret may do or spend', () => {
    // Act
    const actual = configLoosening('modelsGuide', {}, { prompt: 'Everything on claude-opus-5-5 at max.' });

    // Assert
    should(actual).deepEqual([]);
    should(configValue('pack', {})).deepEqual(DEFAULT_PACK_CONFIG);
  });
});
