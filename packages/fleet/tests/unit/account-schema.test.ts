import { describe, it } from 'bun:test';
import { CONFIG_COMPONENT_KINDS } from '@ferretry/protocol';
import should from 'should';
import {
  AccountModelSchema,
  COMPONENT_KINDS,
  isRuntimeName,
  type LayeredProfile,
  layerReferenceText,
  parseAccountModel,
  parseLayerReference,
  resolveDefaultRuntime,
  wouldIncludeItself,
} from '../../src/lib/account/schema.ts';

/** A valid document with one of everything, so a test only varies what it is about. */
const documentWith = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: 2,
  credentials: { 'claude-you': { harness: 'claude', store: 'host' } },
  components: {
    instructions: { main: { file: 'components/instructions/main.md' } },
    modelSets: { heavy: { models: ['claude-opus-5-5', 'claude-sonnet-5-5'], default: 'claude-opus-5-5' } },
  },
  profiles: { default: { layers: ['instructions/main', 'modelSets/heavy'] } },
  runtimes: { 'claude-default': { credential: 'claude-you', profile: 'default' } },
  ...overrides,
});

/** Every issue a failed parse produced, as `path: message`, so a test asserts on cause. */
const messagesOf = (input: unknown): string[] => {
  const parsed = AccountModelSchema.safeParse(input);
  return parsed.success ? [] : parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`);
};

describe('AccountModelSchema', () => {
  it('should fill every default a beginner never writes', () => {
    // Arrange
    const input = documentWith();

    // Act
    const actual = parseAccountModel(input);

    // Assert
    should(actual.machine).deepEqual({
      agentPermissions: 'auto',
      agentControl: { terminals: true, browsers: true, files: true, ferretrySettings: false },
      browserMode: 'headless',
      autoResume: true,
      conversations: { listComputer: true },
    });
    should(actual.runtimes['claude-default']).deepEqual({ credential: 'claude-you', profile: 'default', agent: false });
    should(actual.components.mcp).deepEqual({});
    should(actual.components.settings).deepEqual({});
    should(actual.advanced.aliases).deepEqual({});
    should(actual.advanced.commands).deepEqual([]);
    should(actual.advanced.path).deepEqual({ announce: true });
    should(actual.advanced.usage.interval).equal(60);
  });

  it('should default a credential to a login Ferretry keeps', () => {
    // Arrange
    const input = documentWith({
      credentials: {
        'claude-you': { harness: 'claude' },
        work: { harness: 'codex', label: 'work', clonedFrom: 'studio-mac' },
      },
    });

    // Act
    const actual = AccountModelSchema.safeParse(input);

    // Assert
    should(actual.data?.credentials.work).deepEqual({
      harness: 'codex',
      store: 'ferretry',
      label: 'work',
      clonedFrom: 'studio-mac',
    });
  });

  it('should parse the design document example of a layered agent profile', () => {
    // Arrange — §5.2: agent-work takes the default profile, then the agent profile on top
    const input = documentWith({
      components: {
        settings: { 'agent-settings': { harness: 'claude', file: 'components/settings/agent-settings.json' } },
        modelSets: { heavy: { models: ['claude-opus-5-5'], default: 'claude-opus-5-5' } },
      },
      profiles: {
        default: { layers: ['modelSets/heavy'] },
        agent: { layers: ['settings/agent-settings', 'modelSets/heavy'] },
        'agent-work': { layers: ['profile/default', 'profile/agent'] },
      },
      runtimes: { 'claude-agent': { credential: 'claude-you', profile: 'agent-work', agent: true } },
    });

    // Act
    const actual = messagesOf(input);

    // Assert
    should(actual).deepEqual([]);
  });

  it('should refuse any version other than 2', () => {
    // Act
    const actual = messagesOf(documentWith({ version: 3 }));

    // Assert
    should(actual).matchAny(/^version: /);
  });

  it('should refuse an unknown key anywhere, rather than ignore a typo', () => {
    // Act
    const actual = messagesOf(
      documentWith({ runtimes: { a: { credential: 'claude-you', profile: 'default', agnet: true } } }),
    );

    // Assert
    should(actual).matchAny(/agnet/);
  });

  it.each(['has space', '-leading', 'trailing-', 'dot.ted', 'under_score', ''])(
    'should refuse runtime name %p',
    name => {
      // Act
      const actual = messagesOf(
        documentWith({ runtimes: { [name]: { credential: 'claude-you', profile: 'default' } } }),
      );

      // Assert
      should(actual).matchAny(/letters, digits and dashes/);
      should(isRuntimeName(name)).be.false();
    },
  );

  it('should accept a runtime name of letters, digits and dashes', () => {
    // Assert
    should(isRuntimeName('claude-auto-default-2')).be.true();
  });

  it('should refuse a second host login for one harness', () => {
    // Arrange — C4: there is one ~/.claude
    const input = documentWith({
      credentials: { 'claude-you': { harness: 'claude', store: 'host' }, other: { harness: 'claude', store: 'host' } },
    });

    // Act
    const actual = messagesOf(input);

    // Assert
    should(actual).deepEqual([
      'credentials.other.store: "other" and "claude-you" are both your own claude login (store: host) — a machine has only one, so one of them must be store: ferretry',
    ]);
  });

  it('should accept one host login per harness', () => {
    // Act
    const actual = messagesOf(
      documentWith({
        credentials: {
          'claude-you': { harness: 'claude', store: 'host' },
          'codex-you': { harness: 'codex', store: 'host' },
        },
      }),
    );

    // Assert
    should(actual).deepEqual([]);
  });

  it('should require an environment credential to name its variables', () => {
    // Act
    const actual = messagesOf(
      documentWith({ credentials: { 'claude-you': { harness: 'claude', store: 'environment' } } }),
    );

    // Assert
    should(actual).matchAny(/credentials\.claude-you\.env: a credential kept in the environment must say/);
  });

  it('should refuse an empty environment for an environment credential', () => {
    // Act
    const actual = messagesOf(
      documentWith({ credentials: { 'claude-you': { harness: 'claude', store: 'environment', env: {} } } }),
    );

    // Assert
    should(actual).matchAny(/must say which variables/);
  });

  it('should accept an environment credential that names a secret', () => {
    // Act
    const actual = messagesOf(
      documentWith({
        credentials: {
          'claude-you': { harness: 'claude', store: 'environment', env: { ANTHROPIC_API_KEY: '${secret:WORK_KEY}' } },
        },
      }),
    );

    // Assert
    should(actual).deepEqual([]);
  });

  it('should refuse env on a credential that is a login', () => {
    // Act
    const actual = messagesOf(
      documentWith({ credentials: { 'claude-you': { harness: 'claude', store: 'host', env: { A: 'b' } } } }),
    );

    // Assert
    should(actual).matchAny(/"env" belongs only to a credential with store: environment — this one is store: host/);
  });

  it('should refuse the secure-storage variable in a credential environment', () => {
    // Arrange — it would point every runtime on this credential at another login's store
    const input = documentWith({
      credentials: {
        'claude-you': { harness: 'claude', store: 'environment', env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: '/x' } },
      },
    });

    // Act
    const actual = messagesOf(input);

    // Assert
    should(actual).matchAny(/CLAUDE_SECURESTORAGE_CONFIG_DIR" is reserved — Ferretry sets it/);
  });

  describe('components', () => {
    const withComponents = (components: Record<string, unknown>): string[] =>
      messagesOf(documentWith({ components, profiles: { default: { layers: [] } } }));

    it('should accept a command MCP server and a URL MCP server', () => {
      // Act
      const actual = withComponents({
        mcp: {
          github: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-github'],
            env: { TOKEN: '${secret:GH}' },
          },
          linear: { url: 'https://mcp.linear.app/sse', harness: 'claude' },
        },
      });

      // Assert
      should(actual).deepEqual([]);
    });

    it.each([[{}], [{ command: 'npx', url: 'https://example.test/sse' }]])(
      'should refuse an MCP server that is not exactly one of command or url: %p',
      server => {
        // Act
        const actual = withComponents({ mcp: { broken: server } });

        // Assert
        should(actual).matchAny(/mcp\.broken: an MCP server needs exactly one of "command"/);
      },
    );

    it.each([
      ['args', { url: 'https://example.test/sse', args: ['x'] }],
      ['env', { url: 'https://example.test/sse', env: { A: 'b' } }],
    ])('should refuse %s on a server reached at a url', (field, server) => {
      // Act
      const actual = withComponents({ mcp: { remote: server } });

      // Assert
      should(actual).matchAny(new RegExp(`mcp\\.remote\\.${field}: "args" and "env" start a command`));
    });

    it('should refuse auth on a server Ferretry starts, and accept it on one reached at a url', () => {
      // Act
      const started = withComponents({ mcp: { local: { command: 'npx', auth: 'oauth' } } });
      const remote = withComponents({ mcp: { remote: { url: 'https://example.test/mcp', auth: 'oauth' } } });

      // Assert
      should(started).matchAny(/mcp\.local\.auth: "auth" signs in to a server reached at a "url"/);
      should(remote).deepEqual([]);
    });

    it('should refuse auth on a server reached over plain HTTP on another host, and allow this machine', () => {
      // Act
      const cleartext = withComponents({ mcp: { remote: { url: 'http://mcp.example.com/mcp', auth: 'oauth' } } });
      const local = withComponents({ mcp: { dev: { url: 'http://127.0.0.1:8080/mcp', auth: 'oauth' } } });

      // Assert
      should(cleartext).matchAny(/mcp\.remote\.url: "auth" sends a token to this server, so its "url" must be https/);
      should(local).deepEqual([]);
    });

    it('should take a hand-registered client by Claude’s field names, its secret only as a reference', () => {
      // Arrange
      const url = 'https://example.test/mcp';

      // Act
      const good = withComponents({
        mcp: {
          remote: {
            url,
            auth: 'oauth',
            oauth: { clientId: 'abc', clientSecret: `\${secret:REMOTE_CLIENT}`, callbackPort: 8123 },
          },
        },
      });
      const plaintext = withComponents({
        mcp: { remote: { url, auth: 'oauth', oauth: { clientId: 'abc', clientSecret: 's3cr3t-value' } } },
      });
      const unsigned = withComponents({ mcp: { remote: { url, oauth: { clientId: 'abc' } } } });
      const badPort = withComponents({
        mcp: { remote: { url, auth: 'oauth', oauth: { clientId: 'abc', callbackPort: 80 } } },
      });

      // Assert
      should(good).deepEqual([]);
      should(plaintext).matchAny(
        /mcp\.remote\.oauth\.clientSecret: a client secret is written as a \$\{secret:NAME\} reference/,
      );
      should(unsigned).matchAny(/mcp\.remote\.oauth: "oauth" names the client a sign-in uses/);
      should(badPort).matchAny(/mcp\.remote\.oauth\.callbackPort/);
    });

    it('should refuse a skill item listed twice and an empty selection', () => {
      // Act
      const actual = withComponents({
        skills: { twice: { items: ['review', 'review'] }, none: { items: [] } },
      });

      // Assert
      should(actual).matchAny(/skills\.twice\.items\.1: skill item "review" is listed twice/);
      should(actual).matchAny(/skills\.none\.items/);
    });

    it('should accept settings carrying only flags, or only env', () => {
      // Act
      const actual = withComponents({
        settings: {
          'verbose-flags': { harness: 'claude', flags: ['--verbose'] },
          debug: { harness: 'codex', env: { LOG_LEVEL: 'debug' } },
          both: { harness: 'claude', file: 'components/settings/both.json', flags: ['--verbose'], env: { A: 'b' } },
        },
      });

      // Assert
      should(actual).deepEqual([]);
    });

    it('should refuse a settings component that says nothing', () => {
      // Act
      const actual = withComponents({ settings: { empty: { harness: 'claude' } } });

      // Assert
      should(actual).deepEqual([
        'components.settings.empty: a settings component needs at least one of "file", "flags" or "env"',
      ]);
    });

    it('should refuse settings or hooks that name no harness', () => {
      // Act
      const actual = withComponents({
        settings: { loose: { file: 'a.json' } },
        hooks: { loose: { file: 'hooks.json' } },
      });

      // Assert
      should(actual).matchAny(/components\.settings\.loose\.harness/);
      should(actual).matchAny(/components\.hooks\.loose\.harness/);
    });

    it('should accept a hooks file and a hooks directory', () => {
      // Act
      const actual = withComponents({
        hooks: {
          'format-on-save': { harness: 'claude', file: 'components/hooks/format-on-save.json' },
          scripts: { harness: 'codex', directory: 'components/hooks/scripts' },
        },
      });

      // Assert
      should(actual).deepEqual([]);
    });

    it.each([[{ harness: 'codex' }], [{ harness: 'codex', file: 'a.json', directory: 'scripts' }]])(
      'should refuse hooks that are not exactly one of file or directory: %p',
      hooks => {
        // Act
        const actual = withComponents({ hooks: { broken: hooks } });

        // Assert
        should(actual).matchAny(/hooks\.broken: a hooks component needs exactly one of "file"/);
      },
    );

    it('should refuse a model set whose default is not one of its models', () => {
      // Act
      const actual = withComponents({ modelSets: { odd: { models: ['a', 'b'], default: 'c' } } });

      // Assert
      should(actual).deepEqual([
        'components.modelSets.odd.default: default "c" is not one of this model set\'s models (a, b)',
      ]);
    });

    it('should refuse a model listed twice in a model set', () => {
      // Act
      const actual = withComponents({ modelSets: { twice: { models: ['a', 'a'], default: 'a' } } });

      // Assert
      should(actual).deepEqual(['components.modelSets.twice.models.1: model "a" is listed twice']);
    });

    it('should refuse a component name that would break a layer reference', () => {
      // Act
      const actual = withComponents({ instructions: { 'a/b': { file: 'x.md' } } });

      // Assert
      should(actual).matchAny(/path separator/);
    });
  });

  describe('profiles', () => {
    it('should refuse text that is not a layer, naming the kinds that exist', () => {
      // Act
      const actual = messagesOf(documentWith({ profiles: { default: { layers: ['flags/fast'] } } }));

      // Assert
      should(actual).deepEqual([
        'profiles.default.layers.0: "flags/fast" is not a layer — write <kind>/<name> with kind one of instructions, mcp, skills, settings, hooks, modelSets, or profile/<name>',
      ]);
    });

    it('should name the unknown component and what exists instead', () => {
      // Act
      const actual = messagesOf(
        documentWith({ profiles: { default: { layers: ['instructions/mian', 'mcp/github'] } } }),
      );

      // Assert
      should(actual).deepEqual([
        'profiles.default.layers.0: profile "default" uses unknown instructions component "mian" (instructions: main)',
        'profiles.default.layers.1: profile "default" uses unknown mcp component "github" (mcp: none)',
      ]);
    });

    it('should name an unknown base profile', () => {
      // Act
      const actual = messagesOf(documentWith({ profiles: { default: { layers: ['profile/base'] } } }));

      // Assert
      should(actual).deepEqual([
        'profiles.default.layers.0: profile "default" uses unknown profile "base" as a layer (profiles: default)',
      ]);
    });

    it('should refuse a profile that includes itself directly or through a base', () => {
      // Arrange — P3: a → b → a, and c → c
      const input = documentWith({
        profiles: {
          default: { layers: [] },
          a: { layers: ['profile/b'] },
          b: { layers: ['profile/a', 'profile/default'] },
          c: { layers: ['profile/c'] },
        },
      });

      // Act
      const actual = messagesOf(input);

      // Assert
      should(actual).deepEqual([
        'profiles.a.layers: profile "a" includes itself through its layers — a profile can never be its own base',
        'profiles.b.layers: profile "b" includes itself through its layers — a profile can never be its own base',
        'profiles.c.layers: profile "c" includes itself through its layers — a profile can never be its own base',
      ]);
    });

    it('should count a component reached twice as no error', () => {
      // Act — P2 says it counts once, at its newest position; that is the layering module's job
      const actual = messagesOf(
        documentWith({ profiles: { default: { layers: ['instructions/main', 'instructions/main'] } } }),
      );

      // Assert
      should(actual).deepEqual([]);
    });
  });

  describe('runtimes', () => {
    it('should name an unknown credential and an unknown profile', () => {
      // Act
      const actual = messagesOf(documentWith({ runtimes: { r: { credential: 'nobody', profile: 'nothing' } } }));

      // Assert
      should(actual).deepEqual([
        'runtimes.r.credential: runtime "r" uses unknown credential "nobody" (credentials: claude-you)',
        'runtimes.r.profile: runtime "r" uses unknown profile "nothing" (profiles: default)',
      ]);
    });
  });

  describe('machine.defaultRuntime (T)', () => {
    it('should accept a default runtime that is an agent runtime on this machine', () => {
      // Act
      const actual = parseAccountModel(
        documentWith({
          machine: { defaultRuntime: 'claude-default' },
          runtimes: { 'claude-default': { credential: 'claude-you', profile: 'default', agent: true } },
        }),
      );

      // Assert
      should(actual.machine.defaultRuntime).equal('claude-default');
    });

    it('should refuse a default runtime that does not exist, naming the agent runtimes there are', () => {
      // Act
      const actual = messagesOf(
        documentWith({
          machine: { defaultRuntime: 'missing' },
          runtimes: { 'claude-default': { credential: 'claude-you', profile: 'default', agent: true } },
        }),
      );

      // Assert
      should(actual).deepEqual([
        'machine.defaultRuntime: the default runtime for new agents, "missing", is not an agent runtime on this machine (agent runtimes: claude-default)',
      ]);
    });

    it('should refuse a default runtime that exists but is not an agent runtime, naming none available', () => {
      // Act
      const actual = messagesOf(
        documentWith({
          machine: { defaultRuntime: 'claude-default' },
          runtimes: { 'claude-default': { credential: 'claude-you', profile: 'default', agent: false } },
        }),
      );

      // Assert
      should(actual).deepEqual([
        'machine.defaultRuntime: the default runtime for new agents, "claude-default", is not an agent runtime on this machine (agent runtimes: none)',
      ]);
    });
  });

  describe('advanced', () => {
    it('should accept a command that runs a runtime, and an alias', () => {
      // Act
      const actual = AccountModelSchema.safeParse(
        documentWith({
          advanced: {
            secretsFile: '~/.secrets',
            commands: [{ wrapper: 'claude-fast', runtime: 'claude-default' }],
            aliases: { yolo: { claude: '--dangerously-skip-permissions' } },
            path: { announce: false },
          },
        }),
      );

      // Assert
      should(actual.success).be.true();
      should(actual.data?.advanced.commands).deepEqual([
        { wrapper: 'claude-fast', runtime: 'claude-default', flags: [] },
      ]);
    });

    it('should refuse a command for an unknown runtime, or one that takes a name already in use', () => {
      // Act
      const actual = messagesOf(
        documentWith({
          advanced: {
            commands: [
              { wrapper: 'claude-default', runtime: 'claude-default' },
              { wrapper: 'fast', runtime: 'missing' },
              { wrapper: 'fast', runtime: 'claude-default' },
            ],
          },
        }),
      );

      // Assert
      should(actual).deepEqual([
        'advanced.commands.0.wrapper: command "claude-default" has the same name as runtime claude-default',
        'advanced.commands.1.runtime: command "fast" runs unknown runtime "missing"',
        'advanced.commands.2.wrapper: command "fast" has the same name as command fast',
      ]);
    });
  });
});

describe('parseLayerReference', () => {
  it.each([
    ['instructions/main', { kind: 'component', componentKind: 'instructions', name: 'main' }],
    ['modelSets/heavy', { kind: 'component', componentKind: 'modelSets', name: 'heavy' }],
    ['profile/default', { kind: 'profile', name: 'default' }],
  ])('should read %p', (text, expected) => {
    // Act
    const actual = parseLayerReference(text);

    // Assert
    should(actual).deepEqual(expected);
    should(layerReferenceText(actual as NonNullable<typeof actual>)).equal(text);
  });

  it.each(['main', 'profiles/default', 'instructions/', 'instructions/a/b', 'mcp/..'])('should refuse %p', text => {
    // Assert
    should(parseLayerReference(text)).be.undefined();
  });
});

describe('wouldIncludeItself', () => {
  const profiles: Readonly<Record<string, LayeredProfile>> = {
    base: { layers: ['instructions/main'] },
    middle: { layers: ['profile/base'] },
    top: { layers: ['profile/middle', 'profile/base'] },
  };

  it('should disable a profile as its own base', () => {
    // Assert
    should(wouldIncludeItself(profiles, 'base', 'base')).be.true();
  });

  it('should disable a base that already includes the profile being edited', () => {
    // Arrange — E19: editing base, top includes base through middle
    // Assert
    should(wouldIncludeItself(profiles, 'base', 'top')).be.true();
  });

  it('should allow a base that does not include the profile being edited', () => {
    // Assert
    should(wouldIncludeItself(profiles, 'top', 'middle')).be.false();
  });
});

describe('resolveDefaultRuntime', () => {
  it('should use the explicit setting', () => {
    // Act
    const actual = resolveDefaultRuntime(
      parseAccountModel(
        documentWith({
          machine: { defaultRuntime: 'claude-review' },
          runtimes: {
            'claude-default': { credential: 'claude-you', profile: 'default', agent: true },
            'claude-review': { credential: 'claude-you', profile: 'default', agent: true },
          },
        }),
      ),
    );

    // Assert
    should(actual).equal('claude-review');
  });

  it('should fall back to claude-default when it is an agent runtime and nothing was set', () => {
    // Act
    const actual = resolveDefaultRuntime(
      parseAccountModel(
        documentWith({ runtimes: { 'claude-default': { credential: 'claude-you', profile: 'default', agent: true } } }),
      ),
    );

    // Assert
    should(actual).equal('claude-default');
  });

  it('should resolve to nothing when claude-default is not an agent runtime and nothing was set', () => {
    // Act
    const actual = resolveDefaultRuntime(
      parseAccountModel(
        documentWith({
          runtimes: { 'claude-default': { credential: 'claude-you', profile: 'default', agent: false } },
        }),
      ),
    );

    // Assert
    should(actual).be.undefined();
  });

  it('should resolve to nothing on a machine with no claude-default runtime at all', () => {
    // Act
    const actual = resolveDefaultRuntime(
      parseAccountModel(documentWith({ runtimes: { other: { credential: 'claude-you', profile: 'default' } } })),
    );

    // Assert
    should(actual).be.undefined();
  });
});

describe('the agent-control switches', () => {
  it('should leave agents without the Ferretry settings switch until the owner turns it on', () => {
    // Arrange
    const input = documentWith({ machine: { agentControl: { terminals: false } } });

    // Act
    const actual = parseAccountModel(input).machine.agentControl;

    // Assert — the three older switches default on; this one is a kill switch that defaults off.
    should(actual).deepEqual({ terminals: false, browsers: true, files: true, ferretrySettings: false });
  });

  it('should keep the Ferretry settings switch when the owner sets it', () => {
    // Arrange
    const input = documentWith({ machine: { agentControl: { ferretrySettings: true } } });

    // Act
    const actual = parseAccountModel(input).machine.agentControl.ferretrySettings;

    // Assert
    should(actual).be.true();
  });

  it('should refuse a switch that is not a boolean', () => {
    // Act
    const actual = messagesOf(documentWith({ machine: { agentControl: { ferretrySettings: 'yes' } } }));

    // Assert
    should(actual.some(message => message.startsWith('machine.agentControl.ferretrySettings'))).be.true();
  });
});

describe('the conversations setting', () => {
  it('should list the computer’s conversations unless the owner switches that off', () => {
    // Arrange
    const off = documentWith({ machine: { conversations: { listComputer: false } } });
    const untouched = documentWith({ machine: { conversations: {} } });

    // Act
    const actual = [off, untouched].map(input => parseAccountModel(input).machine.conversations.listComputer);

    // Assert
    should(actual).deepEqual([false, true]);
  });

  it('should refuse a switch that is not a boolean, and a field it does not know', () => {
    // Act
    const notBoolean = messagesOf(documentWith({ machine: { conversations: { listComputer: 'yes' } } }));
    const unknown = messagesOf(documentWith({ machine: { conversations: { adopt: true } } }));

    // Assert
    should(notBoolean.some(message => message.startsWith('machine.conversations.listComputer'))).be.true();
    should(unknown.some(message => message.startsWith('machine.conversations'))).be.true();
  });
});

describe('the component kinds', () => {
  it("should be the protocol's list, so a directory and a profile entry spell a kind the same way", () => {
    // Assert
    should([...COMPONENT_KINDS]).deepEqual([...CONFIG_COMPONENT_KINDS]);
    should([...COMPONENT_KINDS]).deepEqual(['instructions', 'mcp', 'skills', 'settings', 'hooks', 'modelSets']);
  });
});

describe('CredentialSchema — environment logins (docs/provider-presets.md)', () => {
  const env = (credential: Record<string, unknown>) =>
    messagesOf(documentWith({ credentials: { 'claude-you': credential } }));

  it('should accept a login with a preset, a cloud credential reference and no variables of its own', () => {
    should(
      env({
        harness: 'claude',
        store: 'environment',
        preset: 'microsoft-foundry-azure-cli',
        cloudCredential: 'azure-cli',
      }),
    ).deepEqual([]);
  });

  it.each(['preset', 'cloudCredential', 'codexProvider'])('should refuse %s on a login that signs in', field => {
    const value = field === 'codexProvider' ? { id: 'ollama' } : field === 'preset' ? 'kimi' : 'azure-cli';
    should(env({ harness: 'claude', store: 'ferretry', [field]: value })).matchAny(
      new RegExp(`"${field}" belongs only to a credential with store: environment`, 'u'),
    );
  });

  it('should refuse a Codex model provider on a Claude Code login', () => {
    should(env({ harness: 'claude', store: 'environment', codexProvider: { id: 'ollama' } })).matchAny(
      /points Codex at a model provider — this login is for Claude Code/u,
    );
  });

  it('should refuse a Codex provider whose key variable the login does not set', () => {
    should(
      env({
        harness: 'codex',
        store: 'environment',
        env: { OTHER: '1' },
        codexProvider: { id: 'kimi', name: 'Kimi', baseUrl: 'https://api.moonshot.ai/v1', keyVariable: 'KIMI_API_KEY' },
      }),
    ).matchAny(/sends its key from KIMI_API_KEY, so "env" must set KIMI_API_KEY/u);
  });

  it('should refuse a Codex provider whose base URL names a variable the login does not set', () => {
    should(
      env({
        harness: 'codex',
        store: 'environment',
        codexProvider: { id: 'azure', name: 'Azure', baseUrl: 'https://{RESOURCE}.openai.azure.com' },
      }),
    ).matchAny(/names \{RESOURCE\}, so "env" must set RESOURCE/u);
  });

  it("should accept Codex's own Ollama provider with no variables at all", () => {
    should(env({ harness: 'codex', store: 'environment', codexProvider: { id: 'ollama' } })).deepEqual([]);
  });

  it('should refuse a variable its cloud credential reference already sets', () => {
    should(
      env({ harness: 'claude', store: 'environment', env: { AWS_PROFILE: 'x' }, cloudCredential: 'aws-profile:acme' }),
    ).matchAny(/AWS_PROFILE comes from "cloudCredential" \(aws-profile:acme\) — leave it out of "env"/u);
  });

  it('should refuse something that is not a cloud credential reference', () => {
    should(env({ harness: 'claude', store: 'environment', cloudCredential: 'aws:acme' })).matchAny(
      /is not a cloud credential reference/u,
    );
  });
});

describe('CredentialSchema — halves (docs/provider-presets.md § One login, both CLIs)', () => {
  const env = (credential: Record<string, unknown>) =>
    messagesOf(documentWith({ credentials: { 'claude-you': credential } }));

  it('should accept a login with a claude half and a codex half, harness naming one of them', () => {
    should(
      env({
        harness: 'claude',
        store: 'environment',
        claude: { env: { ANTHROPIC_AUTH_TOKEN: '${secret:S}' } },
        codex: { env: { OPENROUTER_API_KEY: '${secret:S}' } },
      }),
    ).deepEqual([]);
  });

  it('should refuse a harness that names neither of the login’s halves', () => {
    should(
      env({
        harness: 'codex',
        store: 'environment',
        claude: { env: { ANTHROPIC_AUTH_TOKEN: '${secret:S}' } },
      }),
    ).matchAny(/"harness: codex" must name one of this login's halves \(claude\)/u);
  });

  it('should refuse a top-level codexProvider on a halved login', () => {
    should(
      env({
        harness: 'claude',
        store: 'environment',
        claude: { env: { A: '1' } },
        codexProvider: { id: 'ollama' },
      }),
    ).matchAny(/"codexProvider" goes inside "codex:" when the login has halves/u);
  });

  it('should refuse a codexProvider placed in the claude half', () => {
    should(
      env({
        harness: 'claude',
        store: 'environment',
        claude: { env: { A: '1' }, codexProvider: { id: 'ollama' } },
      }),
    ).matchAny(/"codexProvider" points Codex at a model provider — it goes in "codex:", not "claude:"/u);
  });

  it('should refuse a halved login whose codex provider’s key variable is not set in the codex half', () => {
    should(
      env({
        harness: 'claude',
        store: 'environment',
        claude: { env: { A: '1' } },
        codex: {
          env: { OTHER: '1' },
          codexProvider: {
            id: 'kimi',
            name: 'Kimi',
            keyVariable: 'KIMI_API_KEY',
            baseUrl: 'https://api.moonshot.ai/v1',
          },
        },
      }),
    ).matchAny(/sends its key from KIMI_API_KEY, so "env" must set KIMI_API_KEY/u);
  });

  it('should require a halved login to say which variables authenticate it, across every half', () => {
    should(env({ harness: 'claude', store: 'environment', claude: {}, codex: {} })).matchAny(
      /must say which variables authenticate it/u,
    );
  });

  it('should accept a halved login whose shared cloud credential variable is not repeated in a half', () => {
    should(
      env({
        harness: 'claude',
        store: 'environment',
        env: { CLAUDE_CODE_USE_BEDROCK: '1' },
        cloudCredential: 'aws-profile:acme',
        claude: { env: { A: '1' } },
      }),
    ).deepEqual([]);
  });
});

describe('RuntimeSchema.harness (docs/provider-presets.md § One login, both CLIs)', () => {
  const dualDocument = (runtime: Record<string, unknown>) =>
    documentWith({
      credentials: {
        glm: {
          harness: 'claude',
          store: 'environment',
          claude: { env: { ANTHROPIC_AUTH_TOKEN: '${secret:S}' } },
          codex: { env: { OPENROUTER_API_KEY: '${secret:S}' } },
        },
      },
      runtimes: { 'claude-default': { credential: 'glm', profile: 'default', ...runtime } },
    });

  it('should accept a runtime naming the half of a dual login it runs', () => {
    should(messagesOf(dualDocument({ harness: 'codex' }))).deepEqual([]);
  });

  it('should refuse a runtime naming a half its login does not drive', () => {
    should(
      messagesOf(
        documentWith({
          runtimes: { 'claude-default': { credential: 'claude-you', profile: 'default', harness: 'codex' } },
        }),
      ),
    ).deepEqual([
      'runtimes.claude-default.harness: runtime "claude-default" runs codex, but login "claude-you" drives only claude',
    ]);
  });

  it('should default a runtime with no harness to its login’s own', () => {
    should(parseAccountModel(dualDocument({})).runtimes['claude-default']).deepEqual({
      credential: 'glm',
      profile: 'default',
      agent: false,
    });
  });
});
