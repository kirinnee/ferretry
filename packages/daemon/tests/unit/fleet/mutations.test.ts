import { describe, it } from 'bun:test';
import { type FleetConfig, FleetConfigSchema } from '@ferretry/fleet';
import should from 'should';
import {
  applyFleetMutation,
  derivedWrapperName,
  type FleetMutation,
  FleetMutationRefusal,
  FleetMutationSchema,
} from '../../../src/lib/fleet/mutations.ts';

const ID_ONE = '00000000-0000-4000-8000-000000000001';
const ID_MINTED = '00000000-0000-4000-8000-0000000000aa';

const mintId = (): string => ID_MINTED;

/** Parse rather than hand-build, so every fixture is configuration a person could have written. */
const configOf = (input: Record<string, unknown> = {}): FleetConfig => {
  const parsed = FleetConfigSchema.safeParse({ variants: { default: {}, auto: { mode: 'auto' } }, ...input });
  if (!parsed.success) throw new Error(`fixture is not valid: ${JSON.stringify(parsed.error.issues)}`);
  return parsed.data;
};

const existing = (): FleetConfig =>
  configOf({
    agents: [
      {
        name: 'kirin',
        kind: 'claude',
        routes: {
          default: {
            id: ID_ONE,
            wrapper: 'claude-kirin',
            home: 'claude-kirin',
            displayName: 'Kirin',
            mode: 'interactive',
            defaultModel: 'model-one',
            models: ['model-one', 'model-two'],
          },
        },
      },
    ],
  });

const mutationOf = (input: Record<string, unknown>): FleetMutation => {
  const parsed = FleetMutationSchema.safeParse(input);
  if (!parsed.success) throw new Error(`mutation is not valid: ${JSON.stringify(parsed.error.issues)}`);
  return parsed.data;
};

const refusalOf = (act: () => unknown): string => {
  try {
    act();
  } catch (error) {
    should(error).be.instanceof(FleetMutationRefusal);
    return (error as Error).message;
  }
  throw new Error('expected a refusal');
};

const routeOf = (config: FleetConfig, accountId: string): Record<string, unknown> => {
  for (const agent of config.agents) {
    for (const route of Object.values(agent.routes)) {
      if (route.id === accountId) return route as unknown as Record<string, unknown>;
    }
  }
  throw new Error(`no account ${accountId}`);
};

describe('derivedWrapperName', () => {
  it('should keep the bare name for the default lane and spell out every other', () => {
    // Act + Assert
    should(derivedWrapperName('claude', 'kirin', 'default')).equal('claude-kirin');
    should(derivedWrapperName('claude', 'kirin', 'auto')).equal('claude-auto-kirin');
  });
});

describe('applyFleetMutation creating an account', () => {
  it('should mint the identity and derive the wrapper and home from the declared name', () => {
    // Act
    const actual = applyFleetMutation(
      configOf(),
      mutationOf({
        kind: 'create-account',
        harness: 'codex',
        name: 'atomi',
        models: ['model-one'],
        defaultModel: 'model-one',
      }),
      mintId,
    );

    // Assert — a caller never chooses an id, so it cannot collide with or repoint another account.
    should(routeOf(actual, ID_MINTED)).match({ wrapper: 'codex-atomi', home: 'codex-atomi' });
  });

  it('should add a second lane to an agent that already exists rather than a second agent', () => {
    // Act
    const actual = applyFleetMutation(
      existing(),
      mutationOf({
        kind: 'create-account',
        harness: 'claude',
        name: 'kirin',
        variant: 'auto',
        models: ['model-one'],
        defaultModel: 'model-one',
      }),
      mintId,
    );

    // Assert
    should(actual.agents).have.length(1);
    should(Object.keys(actual.agents[0]?.routes ?? {})).deepEqual(['default', 'auto']);
    should(routeOf(actual, ID_MINTED)).match({ wrapper: 'claude-auto-kirin' });
  });

  it('should refuse a lane this fleet does not declare', () => {
    // Act
    const actual = refusalOf(() =>
      applyFleetMutation(
        configOf(),
        mutationOf({
          kind: 'create-account',
          harness: 'claude',
          name: 'kirin',
          variant: 'turbo',
          models: ['model-one'],
          defaultModel: 'model-one',
        }),
        mintId,
      ),
    );

    // Assert
    should(actual).match(/does not declare a "turbo" lane/u);
  });

  it('should refuse a second account on the same agent and lane', () => {
    // Act
    const actual = refusalOf(() =>
      applyFleetMutation(
        existing(),
        mutationOf({
          kind: 'create-account',
          harness: 'claude',
          name: 'kirin',
          models: ['model-one'],
          defaultModel: 'model-one',
        }),
        mintId,
      ),
    );

    // Assert
    should(actual).match(/already has a "default" lane/u);
  });

  it.each([
    [{ models: [] }, /at least one model/u],
    [{ models: ['model-one'], defaultModel: undefined }, /name the default model/u],
    [{ models: ['model-one'], defaultModel: 'model-nine' }, /not one of the models/u],
    [{ models: [], available: false }, /say why it is unavailable/u],
  ])('should refuse an incoherent availability declaration %j', (overrides, expected) => {
    // Act
    const actual = refusalOf(() =>
      applyFleetMutation(
        configOf(),
        mutationOf({ kind: 'create-account', harness: 'claude', name: 'kirin', ...overrides }),
        mintId,
      ),
    );

    // Assert
    should(actual).match(expected);
  });

  it('should accept an unavailable account that says why', () => {
    // Act
    const actual = applyFleetMutation(
      configOf(),
      mutationOf({
        kind: 'create-account',
        harness: 'claude',
        name: 'kirin',
        models: [],
        available: false,
        unavailableReason: 'the provider is down',
      }),
      mintId,
    );

    // Assert
    should(routeOf(actual, ID_MINTED)).match({ available: false, unavailableReason: 'the provider is down' });
  });
});

describe('applyFleetMutation editing an account', () => {
  it('should change only what an edit names', () => {
    // Act — the case that used to blank an account: a layer-only edit.
    const actual = applyFleetMutation(
      existing(),
      mutationOf({ kind: 'edit-account', accountId: ID_ONE, layer: { memory: 'kirin.md' } }),
      mintId,
    );

    // Assert
    should(routeOf(actual, ID_ONE)).match({
      displayName: 'Kirin',
      mode: 'interactive',
      defaultModel: 'model-one',
      available: true,
      layer: { memory: 'kirin.md' },
    });
    should(routeOf(actual, ID_ONE).models).have.length(2);
  });

  it('should preserve every layer field an editor does not display', () => {
    // Arrange — the account already carries far more than an instructions editor shows. Replacing
    // the layer wholesale would erase all of it the first time somebody changed one line of text.
    const config = configOf({
      agents: [
        {
          name: 'kirin',
          kind: 'claude',
          routes: {
            default: {
              id: ID_ONE,
              wrapper: 'claude-kirin',
              home: 'claude-kirin',
              defaultModel: 'model-one',
              models: ['model-one'],
              layer: {
                memory: './old-instructions.md',
                skills: './skills-kirin',
                env: { LANE: 'default' },
                flags: ['--verbose'],
                settings: { theme: 'dark' },
                hooks: './hooks.json',
                hooksDir: './hooks',
                mcp: './mcp.json',
                claude: { memory: './claude-only.md', flags: ['--claude-only'] },
                codex: { skills: './skills-codex' },
              },
            },
          },
        },
      ],
    });

    // Act — an editor that only round-trips instructions sends only instructions. What it sends is
    // held to the asset grammar; what the operator already wrote in the file is not, which is why
    // the untouched fields below keep their `./` spelling.
    const actual = applyFleetMutation(
      config,
      mutationOf({ kind: 'edit-account', accountId: ID_ONE, layer: { memory: 'new-instructions.md' } }),
      mintId,
    );

    // Assert
    should(routeOf(actual, ID_ONE).layer).deepEqual({
      memory: 'new-instructions.md',
      skills: './skills-kirin',
      env: { LANE: 'default' },
      flags: ['--verbose'],
      settings: { theme: 'dark' },
      hooks: './hooks.json',
      hooksDir: './hooks',
      mcp: './mcp.json',
      claude: { memory: './claude-only.md', flags: ['--claude-only'] },
      codex: { skills: './skills-codex' },
    });
  });

  it('should remove exactly the layer fields an edit nulls, nested ones included', () => {
    // Arrange
    const config = configOf({
      agents: [
        {
          name: 'kirin',
          kind: 'claude',
          routes: {
            default: {
              id: ID_ONE,
              wrapper: 'claude-kirin',
              home: 'claude-kirin',
              defaultModel: 'model-one',
              models: ['model-one'],
              layer: {
                memory: './instructions.md',
                skills: './skills-kirin',
                claude: { memory: './claude-only.md', flags: ['--claude-only'] },
              },
            },
          },
        },
      ],
    });

    // Act
    const actual = applyFleetMutation(
      config,
      mutationOf({
        kind: 'edit-account',
        accountId: ID_ONE,
        layer: { skills: null, claude: { flags: null } },
      }),
      mintId,
    );

    // Assert — one field removed at the top level, one inside an overlay, everything else intact.
    should(routeOf(actual, ID_ONE).layer).deepEqual({
      memory: './instructions.md',
      claude: { memory: './claude-only.md' },
    });
  });

  it('should remove the whole overlay when an edit nulls the layer itself', () => {
    // Arrange
    const config = configOf({
      agents: [
        {
          name: 'kirin',
          kind: 'claude',
          routes: {
            default: {
              id: ID_ONE,
              wrapper: 'claude-kirin',
              home: 'claude-kirin',
              defaultModel: 'model-one',
              models: ['model-one'],
              layer: { memory: './instructions.md', skills: './skills-kirin' },
            },
          },
        },
      ],
    });

    // Act
    const actual = applyFleetMutation(
      config,
      mutationOf({ kind: 'edit-account', accountId: ID_ONE, layer: null }),
      mintId,
    );

    // Assert
    should(Object.hasOwn(routeOf(actual, ID_ONE), 'layer')).be.false();
  });

  it('should remove a field an edit explicitly nulls', () => {
    // Act
    const actual = applyFleetMutation(
      existing(),
      mutationOf({ kind: 'edit-account', accountId: ID_ONE, displayName: null }),
      mintId,
    );

    // Assert
    should(Object.hasOwn(routeOf(actual, ID_ONE), 'displayName')).be.false();
  });

  it('should never change the identity every consumer joins on', () => {
    // Act
    const actual = applyFleetMutation(
      existing(),
      mutationOf({ kind: 'edit-account', accountId: ID_ONE, displayName: 'Renamed' }),
      mintId,
    );

    // Assert
    should(routeOf(actual, ID_ONE)).match({ id: ID_ONE, wrapper: 'claude-kirin', home: 'claude-kirin' });
  });

  it('should refuse an account this fleet does not declare', () => {
    // Act
    const actual = refusalOf(() =>
      applyFleetMutation(
        existing(),
        mutationOf({ kind: 'edit-account', accountId: '00000000-0000-4000-8000-00000000ffff' }),
        mintId,
      ),
    );

    // Assert
    should(actual).match(/declares no account with id/u);
  });

  it('should refuse an edit whose result the shared schema would reject', () => {
    // Act — availability coherence is the schema's rule, and an edit is held to it too.
    const actual = refusalOf(() =>
      applyFleetMutation(
        existing(),
        mutationOf({ kind: 'edit-account', accountId: ID_ONE, defaultModel: 'model-nine' }),
        mintId,
      ),
    );

    // Assert
    should(actual).match(/would be invalid/u);
  });
});

describe('applyFleetMutation initializing', () => {
  it('should refuse to derive a configuration, because initialization scaffolds one', () => {
    // Act
    const actual = refusalOf(() => applyFleetMutation(configOf(), mutationOf({ kind: 'initialize' }), mintId));

    // Assert
    should(actual).match(/does not derive a configuration/u);
  });
});
