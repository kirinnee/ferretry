import { describe, it } from 'bun:test';
import should from 'should';
import {
  AccountModelSchema,
  isRuntimeName,
  type LayeredProfile,
  layerReferenceText,
  parseAccountModel,
  parseLayerReference,
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
    should(actual.machine).deepEqual({ agentPermissions: 'auto' });
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
