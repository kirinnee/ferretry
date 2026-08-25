import { describe, it } from 'bun:test';
import should from 'should';
import { FleetConfigSchema, RESERVED_ENV_NAMES } from '../../src/lib/config.ts';

const ID_ONE = '00000000-0000-4000-8000-000000000001';
const ID_TWO = '00000000-0000-4000-8000-000000000002';
const ID_THREE = '00000000-0000-4000-8000-000000000003';

/** A route that satisfies every availability rule, so a test only varies what it is about. */
const route = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: ID_ONE,
  wrapper: 'claude-kirin',
  home: '/homes/claude-kirin',
  defaultModel: 'model-one',
  models: ['model-one'],
  ...overrides,
});

const agent = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'kirin',
  kind: 'claude',
  routes: { default: route() },
  ...overrides,
});

const config = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  agents: [agent()],
  ...overrides,
});

/** Every issue message a failed parse produced, so a test can assert on cause not position. */
const messagesOf = (input: unknown): string[] => {
  const parsed = FleetConfigSchema.safeParse(input);
  return parsed.success ? [] : parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`);
};

describe('FleetConfigSchema', () => {
  it('should parse a minimal configuration and expand nested defaults', () => {
    // Arrange
    const input = config();

    // Act
    const parsed = FleetConfigSchema.safeParse(input);

    // Assert
    should(parsed.success).be.true();
    should(parsed.data?.health).deepEqual({ enabled: false, interval: 300, concurrency: 8, timeout: 90 });
    should(parsed.data?.usage.enabled).be.true();
    should(parsed.data?.usage.interval).equal(60);
    should(parsed.data?.usage.jitter).equal(0.25);
    should(parsed.data?.usage.cliProxy).deepEqual([]);
    should(parsed.data?.sharedHistory).deepEqual({ claude: false, codex: false });
    should(parsed.data?.variants).deepEqual({ default: {} });
  });

  it('should expand inner defaults for a partially supplied nested object', () => {
    // Arrange — supplying one key must not blank out its siblings' defaults
    const input = config({ health: { enabled: true }, usage: { interval: 900 } });

    // Act
    const parsed = FleetConfigSchema.safeParse(input);

    // Assert
    should(parsed.success).be.true();
    should(parsed.data?.health).deepEqual({ enabled: true, interval: 300, concurrency: 8, timeout: 90 });
    should(parsed.data?.usage.interval).equal(900);
    should(parsed.data?.usage.concurrency).equal(6);
    should(parsed.data?.usage.relogin).be.true();
  });

  it('should reject an unknown key at every level', () => {
    // Act + Assert
    should(messagesOf(config({ bogus: 1 }))).matchAny(/bogus/);
    should(messagesOf(config({ agents: [agent({ bogus: 1 })] }))).matchAny(/bogus/);
    should(messagesOf(config({ profiles: { p: { bogus: 1 } } }))).matchAny(/bogus/);
  });

  it.each([
    ['hyphenated', 'auto-atomi'],
    ['alias shaped', 'crc-auto-atomi'],
    ['harness prefixed', 'codex-loge'],
    ['dotted', 'gpt-5.6-sol'],
    ['digits and letters', 'glm52a'],
  ])('should preserve an arbitrary account name (%s)', (_label, name) => {
    // Arrange
    const input = config({ agents: [agent({ name, routes: { default: route({ wrapper: name }) } })] });

    // Act
    const parsed = FleetConfigSchema.safeParse(input);

    // Assert
    should(parsed.success).be.true();
    should(parsed.data?.agents[0]?.name).equal(name);
    should(parsed.data?.agents[0]?.routes.default?.wrapper).equal(name);
  });

  it.each([
    ['a path separator', 'claude/kirin'],
    ['a traversal segment', '../escape'],
    ['a bare traversal', '..'],
    ['leading whitespace', ' kirin'],
  ])('should reject a name that is unsafe as a path component (%s)', (_label, name) => {
    // Act
    const actual = messagesOf(config({ agents: [agent({ routes: { default: route({ wrapper: name }) } })] }));

    // Assert
    should(actual.length).be.above(0);
  });

  it('should require a UUID account id', () => {
    // Act
    const actual = messagesOf(config({ agents: [agent({ routes: { default: route({ id: 'claude-kirin' }) } })] }));

    // Assert
    should(actual).matchAny(/routes\.default\.id/);
  });

  it.each([...RESERVED_ENV_NAMES])('should refuse to let configuration assign %s', reserved => {
    // Arrange — a home is declared by its field; letting the environment override it would lie
    const input = config({ agents: [agent({ env: { [reserved]: '/somewhere/else' } })] });

    // Act
    const actual = messagesOf(input);

    // Assert
    should(actual).matchAny(/reserved/);
  });

  it('should accept literal and referenced environment values', () => {
    // Arrange
    const input = config({
      agents: [agent({ env: { LITERAL: 'plain', REFERENCE: '$PROVIDER_TOKEN', BRACED: '${OTHER_TOKEN}' } })],
    });

    // Act
    const parsed = FleetConfigSchema.safeParse(input);

    // Assert
    should(parsed.success).be.true();
    should(parsed.data?.agents[0]?.env).deepEqual({
      LITERAL: 'plain',
      REFERENCE: '$PROVIDER_TOKEN',
      BRACED: '${OTHER_TOKEN}',
    });
  });

  it('should reject an environment name that is not a POSIX identifier', () => {
    // Act
    const actual = messagesOf(config({ agents: [agent({ env: { 'not-a-name': 'x' } })] }));

    // Assert
    should(actual).matchAny(/POSIX/);
  });

  it('should carry a configurable secrets file through untouched', () => {
    // Arrange
    const input = config({ secretsFile: '~/.config/fy/provider-env' });

    // Act
    const parsed = FleetConfigSchema.safeParse(input);

    // Assert
    should(parsed.data?.secretsFile).equal('~/.config/fy/provider-env');
  });

  it('should leave the secrets file absent when none is configured', () => {
    // Act
    const parsed = FleetConfigSchema.safeParse(config());

    // Assert
    should(parsed.data?.secretsFile).be.undefined();
  });

  it('should reject an unknown profile reference from an agent or a variant', () => {
    // Act
    const fromAgent = messagesOf(config({ agents: [agent({ profiles: ['nope'] })] }));
    const fromVariant = messagesOf(config({ variants: { default: { profiles: ['nope'] } } }));

    // Assert
    should(fromAgent).matchAny(/unknown profile "nope"/);
    should(fromVariant).matchAny(/unknown profile "nope"/);
  });

  it('should reject a route whose variant is not declared', () => {
    // Arrange
    const input = config({
      variants: { default: {} },
      agents: [agent({ routes: { turbo: route() } })],
    });

    // Act
    const actual = messagesOf(input);

    // Assert
    should(actual).matchAny(/unknown variant "turbo"/);
  });

  it('should require at least one route per agent', () => {
    // Act
    const actual = messagesOf(config({ agents: [agent({ routes: {} })] }));

    // Assert
    should(actual).matchAny(/at least one route/);
  });

  it('should reject a duplicate account id even across different agents', () => {
    // Arrange
    const input = config({
      agents: [
        agent(),
        agent({ name: 'atomi', routes: { default: route({ wrapper: 'claude-atomi', home: '/homes/atomi' }) } }),
      ],
    });

    // Act
    const actual = messagesOf(input);

    // Assert
    should(actual).matchAny(/duplicate account id/);
  });

  it('should reject a duplicate wrapper name and a duplicate home', () => {
    // Arrange
    const sameWrapper = config({
      agents: [agent(), agent({ name: 'atomi', routes: { default: route({ id: ID_TWO, home: '/homes/atomi' }) } })],
    });
    const sameHome = config({
      agents: [agent(), agent({ name: 'atomi', routes: { default: route({ id: ID_TWO, wrapper: 'claude-atomi' }) } })],
    });

    // Act + Assert
    should(messagesOf(sameWrapper)).matchAny(/duplicate wrapper/);
    should(messagesOf(sameHome)).matchAny(/duplicate home/);
  });

  it('should reject an unavailable route with no reason, and an available one that states a reason', () => {
    // Arrange
    const silentlyDown = config({
      agents: [agent({ routes: { default: route({ available: false, defaultModel: undefined }) } })],
    });
    const reasonWhileUp = config({
      agents: [agent({ routes: { default: route({ unavailableReason: 'why?' }) } })],
    });

    // Act + Assert
    should(messagesOf(silentlyDown)).matchAny(/must state an unavailableReason/);
    should(messagesOf(reasonWhileUp)).matchAny(/must not carry an unavailableReason/);
  });

  it('should reject a defaultModel that the route declares unavailable', () => {
    // Arrange — the live contradiction this schema exists to prevent
    const input = config({
      agents: [
        agent({
          routes: {
            default: route({
              defaultModel: 'model-down',
              models: [{ id: 'model-down', available: false, unavailableReason: 'provider returns 429' }],
            }),
          },
        }),
      ],
    });

    // Act
    const actual = messagesOf(input);

    // Assert
    should(actual).matchAny(/declared unavailable \(provider returns 429\)/);
  });

  it('should reject a defaultModel the route never lists', () => {
    // Act
    const actual = messagesOf(config({ agents: [agent({ routes: { default: route({ defaultModel: 'ghost' }) } })] }));

    // Assert
    should(actual).matchAny(/is not one of this account's models/);
  });

  it('should require an available route to name a defaultModel', () => {
    // Act
    const actual = messagesOf(
      config({ agents: [agent({ routes: { default: route({ defaultModel: undefined, models: [] }) } })] }),
    );

    // Assert
    should(actual).matchAny(/must name a defaultModel/);
  });

  it('should normalize a bare model string into an available structured model', () => {
    // Act
    const parsed = FleetConfigSchema.safeParse(config());

    // Assert
    should(parsed.data?.agents[0]?.routes.default?.models).deepEqual([{ id: 'model-one', available: true }]);
  });

  /**
   * A model entry used to be parsed against the manifest's PUBLISHED union, whose `true` branch
   * demands `available` be written out. So `{ id, displayName }` — the obvious way to give a model a
   * name a person reads — was refused with `✖ Invalid input`, and the only documented form anywhere
   * was a bare string. An author who could not discover the long form could never declare a model
   * unavailable, which is the one way to say WHY one is off.
   */
  it('should accept the long model form without making an author write "available: true"', () => {
    // Act
    const parsed = FleetConfigSchema.safeParse(
      config({
        agents: [
          agent({
            routes: {
              default: route({
                defaultModel: 'model-one',
                models: [
                  'model-one',
                  { id: 'model-two', displayName: 'Model Two' },
                  { id: 'model-down', available: false, unavailableReason: 'provider returns 429' },
                ],
              }),
            },
          }),
        ],
      }),
    );

    // Assert
    should(parsed.data?.agents[0]?.routes.default?.models).deepEqual([
      { id: 'model-one', available: true },
      { id: 'model-two', available: true, displayName: 'Model Two' },
      { id: 'model-down', available: false, unavailableReason: 'provider returns 429' },
    ]);
  });

  it('should say which field is missing when a model is taken out of service without a reason', () => {
    // Arrange — the two ways to get half of it right. A refusal has to name the field it wants,
    // because "Invalid input" on a union sends an author to re-read a form nothing documents.
    const silent = config({
      agents: [agent({ routes: { default: route({ models: [{ id: 'model-one', available: false }] }) } })],
    });
    const reasonWithoutTheFlag = config({
      agents: [
        agent({
          routes: { default: route({ models: [{ id: 'model-one', unavailableReason: 'provider returns 429' }] }) },
        }),
      ],
    });

    // Act + Assert
    should(messagesOf(silent)).matchAny(/model "model-one" is declared unavailable but does not say why/);
    should(messagesOf(reasonWithoutTheFlag)).matchAny(/gives a reason it is unavailable but is still offered/);
  });

  it('should reject an unknown identity and accept one naming a declared agent', () => {
    // Arrange
    const unknown = config({ agents: [agent({ identity: 'ghost' })] });
    const known = config({
      agents: [
        agent(),
        agent({
          name: 'f5-kirin',
          identity: 'kirin',
          routes: { default: route({ id: ID_TWO, wrapper: 'claude-f5-kirin', home: '/homes/f5' }) },
        }),
      ],
    });

    // Act + Assert
    should(messagesOf(unknown)).matchAny(/unknown identity "ghost"/);
    should(messagesOf(known)).deepEqual([]);
  });

  it('should require commands and default homes to reference accounts by id', () => {
    // Arrange
    const badTarget = config({ commands: [{ wrapper: 'yolo-kirin', target: ID_THREE }] });
    const unknownHome = config({ defaultHomes: { claude: ID_THREE } });
    const wrongKind = config({ defaultHomes: { codex: ID_ONE } });
    const good = config({
      commands: [{ wrapper: 'yolo-kirin', target: ID_ONE, flags: ['--dangerous'] }],
      defaultHomes: { claude: ID_ONE },
    });

    // Act + Assert
    should(messagesOf(badTarget)).matchAny(/unknown target/);
    should(messagesOf(unknownHome)).matchAny(/unknown account id/);
    should(messagesOf(wrongKind)).matchAny(/is a claude account, not codex/);
    should(messagesOf(good)).deepEqual([]);
  });

  it('should reject a command whose wrapper name is already an account wrapper', () => {
    // Act
    const actual = messagesOf(config({ commands: [{ wrapper: 'claude-kirin', target: ID_ONE }] }));

    // Assert
    should(actual).matchAny(/already used by/);
  });

  it('should require an alias to list flags for at least one harness', () => {
    // Act + Assert
    should(messagesOf(config({ aliases: { crc: {} } }))).matchAny(/at least one harness/);
    should(messagesOf(config({ aliases: { crc: { claude: '--chrome --rc' } } }))).deepEqual([]);
  });

  it('should reject a non-positive tuning number in health and in usage alike', () => {
    // Act + Assert
    should(messagesOf(config({ health: { interval: 0 } }))).matchAny(/health\.interval/);
    should(messagesOf(config({ usage: { timeout: 0 } }))).matchAny(/usage\.timeout/);
  });

  it('should require exactly one management credential for a proxy source', () => {
    // Arrange
    const neither = config({ usage: { cliProxy: [{ url: 'http://127.0.0.1:8317', accounts: [ID_ONE] }] } });
    const both = config({
      usage: {
        cliProxy: [
          { url: 'http://127.0.0.1:8317', managementKey: '$KEY', managementKeyFile: '~/key', accounts: [ID_ONE] },
        ],
      },
    });
    const one = config({
      usage: { cliProxy: [{ url: 'http://127.0.0.1:8317', managementKeyFile: '~/key', accounts: [ID_ONE] }] },
    });

    // Act + Assert
    should(messagesOf(neither)).matchAny(/exactly one of managementKey/);
    should(messagesOf(both)).matchAny(/exactly one of managementKey/);
    should(messagesOf(one)).deepEqual([]);
  });

  it('should reject a proxy source naming an account that does not exist', () => {
    // Act
    const actual = messagesOf(
      config({
        usage: { cliProxy: [{ url: 'http://127.0.0.1:8317', managementKeyFile: '~/key', accounts: [ID_THREE] }] },
      }),
    );

    // Assert
    should(actual).matchAny(/unknown account id/);
  });

  it('should report every independent problem from one parse', () => {
    // Arrange
    const input = config({
      agents: [agent({ profiles: ['nope'], identity: 'ghost', routes: { turbo: route() } })],
    });

    // Act
    const actual = messagesOf(input);

    // Assert
    should(actual).matchAny(/unknown profile "nope"/);
    should(actual).matchAny(/unknown identity "ghost"/);
    should(actual).matchAny(/unknown variant "turbo"/);
  });
});

describe('AccountRouteSchema layer', () => {
  it('should accept a route layer carrying every profile field and both harness overlays', () => {
    // Arrange
    const input = config({
      agents: [
        agent({
          routes: {
            default: route({
              layer: {
                env: { LANE: 'default' },
                flags: ['--lane'],
                settings: { theme: 'dark' },
                memory: './default.md',
                skills: './skills-default',
                claude: { memory: './claude.md' },
                codex: { memory: './codex.md' },
              },
            }),
          },
        }),
      ],
    });

    // Act
    const actual = FleetConfigSchema.safeParse(input);

    // Assert
    should(actual.success).be.true();
  });

  it('should refuse an unknown key inside a route layer rather than ignore it', () => {
    // Arrange
    const input = config({
      agents: [agent({ routes: { default: route({ layer: { memroy: './typo.md' } }) } })],
    });

    // Act
    const actual = messagesOf(input);

    // Assert
    should(actual.length).be.above(0);
  });

  it('should refuse a reserved environment name declared in a route layer', () => {
    // Arrange
    const input = config({
      agents: [agent({ routes: { default: route({ layer: { env: { [RESERVED_ENV_NAMES[0]]: '/elsewhere' } } }) } })],
    });

    // Act
    const actual = messagesOf(input);

    // Assert
    should(actual).matchAny(/is reserved/);
  });

  it('should refuse a nested overlay inside a route layer overlay', () => {
    // Arrange
    const input = config({
      agents: [agent({ routes: { default: route({ layer: { claude: { claude: { memory: './nested.md' } } } }) } })],
    });

    // Act
    const actual = messagesOf(input);

    // Assert
    should(actual.length).be.above(0);
  });
});
