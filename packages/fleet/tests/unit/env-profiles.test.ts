/**
 * A profile that authenticates an account instead of a login.
 *
 * The claims under test are the ones `docs/fleet-env-profiles.md` makes: composition is the SAME
 * composition profiles always had, a value is resolved once into one launch and is never returned by
 * anything else, a missing secret refuses rather than resolving to nothing, and the report that says
 * which profile supplied a variable answers in names and never in values.
 *
 * NO REAL CREDENTIAL APPEARS HERE. Every "value" is a fixture string, and the assertions are about
 * where a value goes rather than what it is.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { type FleetConfig, FleetConfigSchema } from '../../src/lib/config.ts';
import {
  describeCompositionOrigin,
  envComposition,
  envValueShape,
  fleetSecretReferences,
  MissingFleetSecretsError,
  resolveSecretEnvironment,
  secretEnvBindings,
} from '../../src/lib/env-profiles.ts';
import { resolveAccounts } from '../../src/lib/profiles.ts';

const ID_ONE = '00000000-0000-4000-8000-000000000001';
const ID_TWO = '00000000-0000-4000-8000-000000000002';

const parse = (input: Record<string, unknown>): FleetConfig => {
  const parsed = FleetConfigSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`fixture is not valid configuration: ${JSON.stringify(parsed.error.issues, null, 2)}`);
  }
  return parsed.data;
};

/** A route that is complete enough to resolve, so every case runs on configuration a person could write. */
const route = (id: string, wrapper: string): Record<string, unknown> => ({
  id,
  wrapper,
  home: wrapper,
  defaultModel: 'model-one',
  models: ['model-one'],
});

/** One agent, one route, with whatever profiles and inline environment the case needs. */
const singleAgent = (input: {
  readonly profiles?: Record<string, unknown>;
  readonly agentProfiles?: readonly string[];
  readonly env?: Record<string, string>;
  readonly routeEnv?: Record<string, string>;
}): FleetConfig =>
  parse({
    ...(input.profiles === undefined ? {} : { profiles: input.profiles }),
    agents: [
      {
        name: 'kirin',
        kind: 'claude',
        auth: 'api-key',
        ...(input.agentProfiles === undefined ? {} : { profiles: input.agentProfiles }),
        ...(input.env === undefined ? {} : { env: input.env }),
        routes: {
          default: {
            ...route(ID_ONE, 'claude-kirin'),
            ...(input.routeEnv === undefined ? {} : { layer: { env: input.routeEnv } }),
          },
        },
      },
    ],
  });

const accountOf = (config: FleetConfig) => {
  const account = resolveAccounts(config)[0];
  if (account === undefined) throw new Error('fixture produced no account');
  return account;
};

describe('secretEnvBindings', () => {
  it('should report only the variables that name a secret, sorted so a re-render is byte-identical', () => {
    // Arrange
    const env = {
      ZZ_LAST: '${secret:LAST_KEY}',
      ANTHROPIC_BASE_URL: 'https://example.invalid',
      ANTHROPIC_API_KEY: '${secret:WORK_KEY}',
    };

    // Act
    const actual = secretEnvBindings(env);

    // Assert
    should(actual).deepEqual([
      { variable: 'ANTHROPIC_API_KEY', secrets: ['WORK_KEY'] },
      { variable: 'ZZ_LAST', secrets: ['LAST_KEY'] },
    ]);
  });

  it('should report every secret one composed value names, in first-appearance order', () => {
    // Arrange
    const env = { AUTH_HEADER: '${secret:SCHEME} ${secret:WORK_KEY} ${secret:SCHEME}' };

    // Act
    const actual = secretEnvBindings(env);

    // Assert
    should(actual).deepEqual([{ variable: 'AUTH_HEADER', secrets: ['SCHEME', 'WORK_KEY'] }]);
  });

  it('should report nothing for an account that binds no secret, which is the default case', () => {
    // Act
    const actual = secretEnvBindings({ ANTHROPIC_BASE_URL: 'https://example.invalid', TOKEN: '$OUTER' });

    // Assert
    should(actual).deepEqual([]);
  });
});

describe('resolveSecretEnvironment', () => {
  it('should resolve a whole-value reference into the one map a launch is given', () => {
    // Arrange
    const account = { id: ID_ONE, env: { ANTHROPIC_API_KEY: '${secret:WORK_KEY}' } };

    // Act
    const actual = resolveSecretEnvironment(account, new Map([['WORK_KEY', 'fixture-value']]));

    // Assert
    should(actual).deepEqual({ ANTHROPIC_API_KEY: 'fixture-value' });
  });

  it('should compose a value that surrounds a reference with text', () => {
    // Arrange
    const account = { id: ID_ONE, env: { AUTH_HEADER: 'Bearer ${secret:WORK_KEY}' } };

    // Act
    const actual = resolveSecretEnvironment(account, new Map([['WORK_KEY', 'fixture-value']]));

    // Assert
    should(actual).deepEqual({ AUTH_HEADER: 'Bearer fixture-value' });
  });

  it('should leave literal variables alone, because the wrapper already exports those itself', () => {
    // Arrange
    const account = {
      id: ID_ONE,
      env: { ANTHROPIC_API_KEY: '${secret:WORK_KEY}', ANTHROPIC_BASE_URL: 'https://example.invalid' },
    };

    // Act
    const actual = resolveSecretEnvironment(account, new Map([['WORK_KEY', 'fixture-value']]));

    // Assert
    should(actual).have.property('ANTHROPIC_API_KEY');
    should(actual).not.have.property('ANTHROPIC_BASE_URL');
  });

  it('should refuse naming EVERY missing secret rather than the first', () => {
    // Arrange
    const account = { id: ID_ONE, env: { A_KEY: '${secret:ONE}', B_KEY: '${secret:TWO} ${secret:ONE}' } };

    // Act
    let raised: unknown;
    try {
      resolveSecretEnvironment(account, new Map());
    } catch (error) {
      raised = error;
    }

    // Assert
    should(raised).be.instanceof(MissingFleetSecretsError);
    should((raised as MissingFleetSecretsError).names).deepEqual(['ONE', 'TWO']);
    should((raised as MissingFleetSecretsError).message).match(/ONE, TWO/u);
  });

  it('should answer an empty environment for an account that binds nothing, without needing a value', () => {
    // Act
    const actual = resolveSecretEnvironment(
      { id: ID_ONE, env: { ANTHROPIC_BASE_URL: 'https://x.invalid' } },
      new Map(),
    );

    // Assert
    should(actual).deepEqual({});
  });
});

describe('envValueShape', () => {
  it('should read a secret reference as a secret even when it is only part of the value', () => {
    // Act & Assert
    should(envValueShape('Bearer ${secret:WORK_KEY}')).deepEqual({ shape: 'secret', secrets: ['WORK_KEY'] });
  });

  it('should read a whole-value environment reference as one, in both spellings', () => {
    // Act & Assert
    should(envValueShape('$OUTER')).deepEqual({ shape: 'environment-reference', variable: 'OUTER' });
    should(envValueShape('${OUTER}')).deepEqual({ shape: 'environment-reference', variable: 'OUTER' });
  });

  it('should read anything else as a literal, and report no text for it', () => {
    // Act
    const actual = envValueShape('https://example.invalid');

    // Assert
    should(actual).deepEqual({ shape: 'literal' });
  });
});

describe('envComposition', () => {
  /** The chain for the fixture's one route, read the way a surface would. */
  const compositionOf = (config: FleetConfig) => {
    const agent = config.agents[0];
    if (agent === undefined) throw new Error('fixture produced no agent');
    const route_ = agent.routes.default;
    if (route_ === undefined) throw new Error('fixture produced no route');
    return envComposition(config, agent, 'default', route_);
  };

  it('should name the slot that supplied the value that won and the slots it overrode', () => {
    // Arrange — the base profile sets it, a named profile replaces it, the account replaces it again.
    const config = singleAgent({
      profiles: {
        base: { env: { ANTHROPIC_API_KEY: '${secret:BASE_KEY}' } },
        work: { env: { ANTHROPIC_API_KEY: '${secret:WORK_KEY}' } },
      },
      agentProfiles: ['work'],
      routeEnv: { ANTHROPIC_API_KEY: '${secret:ACCOUNT_KEY}' },
    });

    // Act
    const actual = compositionOf(config);

    // Assert
    should(actual).have.length(1);
    should(actual[0]?.variable).equal('ANTHROPIC_API_KEY');
    should(actual[0]?.shape).deepEqual({ shape: 'secret', secrets: ['ACCOUNT_KEY'] });
    should(actual[0]?.from).deepEqual({ kind: 'account' });
    should(actual[0]?.overrode).deepEqual([
      { kind: 'base-profile', name: 'base' },
      { kind: 'agent-profile', name: 'work' },
    ]);
  });

  it('should report a variable nothing contested as overriding nothing', () => {
    // Arrange
    const config = singleAgent({ env: { ANTHROPIC_BASE_URL: 'https://example.invalid' } });

    // Act
    const actual = compositionOf(config);

    // Assert
    should(actual).deepEqual([
      {
        variable: 'ANTHROPIC_BASE_URL',
        shape: { shape: 'literal' },
        from: { kind: 'agent', name: 'kirin' },
        overrode: [],
      },
    ]);
  });

  it('should read a harness overlay as the slot that carried it, so a claude: block is not a second slot', () => {
    // Arrange
    const config = parse({
      profiles: { work: { env: { A_KEY: '${secret:FLAT}' }, claude: { env: { A_KEY: '${secret:OVERLAY}' } } } },
      agents: [
        {
          name: 'kirin',
          kind: 'claude',
          auth: 'api-key',
          profiles: ['work'],
          routes: { default: route(ID_ONE, 'claude-kirin') },
        },
      ],
    });

    // Act
    const actual = compositionOf(config);

    // Assert — the overlay won inside its own slot, and the slot is still reported as one.
    should(actual[0]?.shape).deepEqual({ shape: 'secret', secrets: ['OVERLAY'] });
    should(actual[0]?.from).deepEqual({ kind: 'agent-profile', name: 'work' });
    should(actual[0]?.overrode).deepEqual([]);
  });

  it('should report the variant and its profiles as the slots they are', () => {
    // Arrange
    const config = parse({
      profiles: { lane: { env: { A_KEY: '${secret:FROM_PROFILE}' } } },
      variants: { auto: { profiles: ['lane'], env: { A_KEY: '${secret:FROM_VARIANT}' } } },
      agents: [
        {
          name: 'kirin',
          kind: 'claude',
          auth: 'api-key',
          routes: { auto: route(ID_ONE, 'claude-auto-kirin') },
        },
      ],
    });
    const agent = config.agents[0];
    const declared = agent?.routes.auto;
    if (agent === undefined || declared === undefined) throw new Error('fixture produced no route');

    // Act
    const actual = envComposition(config, agent, 'auto', declared);

    // Assert
    should(actual[0]?.from).deepEqual({ kind: 'variant', name: 'auto' });
    should(actual[0]?.overrode).deepEqual([{ kind: 'variant-profile', name: 'lane' }]);
  });

  it('should sort by variable, so two hosts reading one configuration report one order', () => {
    // Arrange
    const config = singleAgent({ env: { ZZ: 'z', AA: 'a', MM: 'm' } });

    // Act
    const actual = compositionOf(config).map(binding => binding.variable);

    // Assert
    should(actual).deepEqual(['AA', 'MM', 'ZZ']);
  });
});

describe('describeCompositionOrigin', () => {
  it('should name every slot in words, and never say "layer" or "lane"', () => {
    // Act
    const sentences = [
      describeCompositionOrigin({ kind: 'base-profile', name: 'base' }),
      describeCompositionOrigin({ kind: 'agent-profile', name: 'work' }),
      describeCompositionOrigin({ kind: 'variant-profile', name: 'work' }),
      describeCompositionOrigin({ kind: 'variant', name: 'auto' }),
      describeCompositionOrigin({ kind: 'agent', name: 'kirin' }),
      describeCompositionOrigin({ kind: 'account' }),
    ];

    // Assert
    should(sentences).deepEqual([
      'the base profile',
      'the profile "work"',
      'the profile "work"',
      'the variant "auto"',
      'the agent "kirin"',
      'this account',
    ]);
    // The vocabulary rule, asserted rather than remembered: both words were removed from every screen
    // and a sentence explaining where somebody's credential came from is the last place to bring one back.
    for (const sentence of sentences) should(sentence).not.match(/\b(layer|lane)\b/iu);
  });
});

describe('fleetSecretReferences', () => {
  it('should name every account that reaches for a secret, with the profile that set it', () => {
    // Arrange
    const config = parse({
      profiles: { work: { env: { ANTHROPIC_API_KEY: '${secret:WORK_KEY}' } } },
      agents: [
        {
          name: 'kirin',
          kind: 'claude',
          auth: 'api-key',
          profiles: ['work'],
          routes: { default: route(ID_ONE, 'claude-kirin') },
        },
        {
          name: 'hadi',
          kind: 'claude',
          auth: 'api-key',
          profiles: ['work'],
          routes: { default: route(ID_TWO, 'claude-hadi') },
        },
      ],
    });

    // Act
    const actual = fleetSecretReferences(config);

    // Assert — two accounts sharing one secret are two facts, so deleting it breaks two things.
    should(actual).deepEqual([
      {
        name: 'WORK_KEY',
        account: 'claude-kirin',
        variable: 'ANTHROPIC_API_KEY',
        origin: 'fleet account claude-kirin → ANTHROPIC_API_KEY, set by the profile "work"',
      },
      {
        name: 'WORK_KEY',
        account: 'claude-hadi',
        variable: 'ANTHROPIC_API_KEY',
        origin: 'fleet account claude-hadi → ANTHROPIC_API_KEY, set by the profile "work"',
      },
    ]);
  });

  it('should say what the winning slot beat, so one variable bound in three places is explainable', () => {
    // Arrange — the base profile, a named profile and the account itself all bind the credential.
    const config = parse({
      profiles: {
        base: { env: { ANTHROPIC_API_KEY: '${secret:SHARED_KEY}' } },
        work: { env: { ANTHROPIC_API_KEY: '${secret:TEAM_KEY}' } },
      },
      agents: [
        {
          name: 'kirin',
          kind: 'claude',
          auth: 'api-key',
          profiles: ['work'],
          routes: {
            default: {
              ...route(ID_ONE, 'claude-kirin'),
              layer: { env: { ANTHROPIC_API_KEY: '${secret:MINE_KEY}' } },
            },
          },
        },
      ],
    });

    // Act
    const actual = fleetSecretReferences(config);

    // Assert — the winner AND what it overrode. Told only the winner, a person cannot tell a
    // deliberate override from the same variable typed into two profiles by mistake, and the listing
    // is the only place this fleet's composition is visible.
    should(actual).deepEqual([
      {
        name: 'MINE_KEY',
        account: 'claude-kirin',
        variable: 'ANTHROPIC_API_KEY',
        origin:
          'fleet account claude-kirin → ANTHROPIC_API_KEY, set by this account, overriding the base profile and the profile "work"',
      },
    ]);
  });

  it('should report one entry per secret when one variable names two', () => {
    // Arrange
    const config = singleAgent({ env: { AUTH_HEADER: '${secret:SCHEME} ${secret:WORK_KEY}' } });

    // Act
    const actual = fleetSecretReferences(config).map(reference => reference.name);

    // Assert
    should(actual).deepEqual(['SCHEME', 'WORK_KEY']);
  });

  it('should report nothing for a fleet that uses no profile, which must keep working untouched', () => {
    // Arrange
    const config = singleAgent({ env: { ANTHROPIC_BASE_URL: 'https://example.invalid' } });

    // Act & Assert
    should(fleetSecretReferences(config)).deepEqual([]);
  });
});

describe('the composed account a profile produces', () => {
  it('should merge the same way profiles always merged, so composition needed no second mechanism', () => {
    // Arrange — two profiles, the later one replacing one variable and adding another.
    const config = singleAgent({
      profiles: {
        base: { env: { ANTHROPIC_API_KEY: '${secret:BASE_KEY}', ANTHROPIC_BASE_URL: 'https://base.invalid' } },
        work: { env: { ANTHROPIC_API_KEY: '${secret:WORK_KEY}', WORK_ONLY: 'yes' } },
      },
      agentProfiles: ['work'],
    });

    // Act
    const account = accountOf(config);

    // Assert
    should(account.env).deepEqual({
      ANTHROPIC_API_KEY: '${secret:WORK_KEY}',
      ANTHROPIC_BASE_URL: 'https://base.invalid',
      WORK_ONLY: 'yes',
    });
  });
});
