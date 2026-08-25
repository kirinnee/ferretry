import { describe, it } from 'bun:test';
import { type FleetConfig, FleetConfigSchema } from '@ferretry/fleet';
import should from 'should';
import {
  applyFleetMutation,
  assertNoOrphanedSharedDocuments,
  createdWrapperNames,
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

/** The one-lane create that every pre-multi-select test was written against. */
const oneLane = (variant = 'default'): Record<string, unknown> => ({ lanes: [{ variant }] });

describe('createdWrapperNames', () => {
  it('should name every wrapper a create publishes, in the order its lanes were named', () => {
    // Arrange — the summary a person approves is derived from this, so a create adding two accounts
    // that named one of them would be a one-line description that is not the change.
    const mutation = mutationOf({
      kind: 'create-account',
      harness: 'claude',
      name: 'kirin',
      lanes: [{ variant: 'default' }, { variant: 'auto' }],
      models: ['model-one'],
      defaultModel: 'model-one',
    });

    // Act + Assert — the naming rule itself lives in @ferretry/fleet and is not restated here.
    should(mutation.kind).equal('create-account');
    if (mutation.kind !== 'create-account') return;
    should(createdWrapperNames(mutation)).deepEqual(['claude-kirin', 'claude-auto-kirin']);
  });

  it('should read a lane that names neither field as the default one', () => {
    // Act
    const mutation = mutationOf({
      kind: 'create-account',
      harness: 'codex',
      name: 'atomi',
      lanes: [{}],
      models: ['model-one'],
      defaultModel: 'model-one',
    });

    // Assert — the wire may omit both members; the fallback lane is this module's, not the schema's.
    should(mutation.kind).equal('create-account');
    if (mutation.kind !== 'create-account') return;
    should(createdWrapperNames(mutation)).deepEqual(['codex-atomi']);
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
        ...oneLane(),
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
        ...oneLane('auto'),
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
          ...oneLane('turbo'),
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
          ...oneLane(),
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
        mutationOf({ kind: 'create-account', harness: 'claude', name: 'kirin', ...oneLane(), ...overrides }),
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
        ...oneLane(),
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

describe('applyFleetMutation creating several lanes at once', () => {
  /** Distinct ids, so two routes minted in one pass are two accounts rather than one written twice. */
  const mintSequence = (): (() => string) => {
    let at = 0;
    return () => {
      at += 1;
      return `00000000-0000-4000-8000-0000000000b${at}`;
    };
  };

  const bothLanes = (overrides: Record<string, unknown> = {}): FleetMutation =>
    mutationOf({
      kind: 'create-account',
      harness: 'claude',
      name: 'kirin',
      displayName: 'Kirin',
      lanes: [
        { variant: 'default', mode: 'interactive' },
        { variant: 'auto', mode: 'auto' },
      ],
      models: ['model-one'],
      defaultModel: 'model-one',
      ...overrides,
    });

  it('should add one route per lane to ONE agent, with one wrapper and one home each', () => {
    // Act
    const actual = applyFleetMutation(configOf(), bothLanes(), mintSequence());

    // Assert — one provider login, two homes. Two agents would be two sign-ins for one account.
    should(actual.agents).have.length(1);
    should(actual.agents[0]).match({ name: 'kirin', kind: 'claude' });
    const routes = actual.agents[0]?.routes ?? {};
    should(Object.keys(routes)).deepEqual(['default', 'auto']);
    should(routes.default).match({ wrapper: 'claude-kirin', home: 'claude-kirin', mode: 'interactive' });
    should(routes.auto).match({ wrapper: 'claude-auto-kirin', home: 'claude-auto-kirin', mode: 'auto' });
    // Identity is minted per route: two accounts that shared an id would be indistinguishable
    // exactly where every consumer joins on it.
    should(routes.default?.id).not.equal(routes.auto?.id);
  });

  it('should share everything but the mode across the accounts one pass creates', () => {
    // Act
    const actual = applyFleetMutation(
      configOf(),
      bothLanes({ layer: { memory: 'instructions/kirin.md' } }),
      mintSequence(),
    );

    // Assert — one model list, one display name, one overlay; the mode is what tells them apart.
    const routes = actual.agents[0]?.routes ?? {};
    for (const route of [routes.default, routes.auto]) {
      should(route).match({ displayName: 'Kirin', defaultModel: 'model-one', available: true });
      should(route?.models).match([{ id: 'model-one' }]);
      should(route?.layer).match({ memory: 'instructions/kirin.md' });
    }
  });

  it('should add every lane to an agent that already exists rather than a second agent', () => {
    // Act — one lane is already there, so only the other is addable.
    const actual = applyFleetMutation(
      existing(),
      mutationOf({
        kind: 'create-account',
        harness: 'claude',
        name: 'kirin',
        lanes: [{ variant: 'auto', mode: 'auto' }],
        models: ['model-one'],
        defaultModel: 'model-one',
      }),
      mintSequence(),
    );

    // Assert
    should(actual.agents).have.length(1);
    should(Object.keys(actual.agents[0]?.routes ?? {})).deepEqual(['default', 'auto']);
  });

  it('should refuse the whole change when ONE of its lanes collides, naming that lane', () => {
    // Act — the fleet already publishes claude-kirin in the default lane.
    const actual = refusalOf(() => applyFleetMutation(existing(), bothLanes(), mintSequence()));

    // Assert — refused before anything was added, and the sentence names which lane earned it.
    should(actual).match(/already has a "default" lane/u);
  });

  it('should refuse two lanes that resolve to the same variant, naming it', () => {
    // Act — a fleet declaring only `default` sends both modes to one slot: two accounts asked for,
    // one wrapper name available. Nothing about either lane is wrong on its own.
    const actual = refusalOf(() =>
      applyFleetMutation(
        configOf({ variants: { default: {} } }),
        mutationOf({
          kind: 'create-account',
          harness: 'claude',
          name: 'kirin',
          lanes: [{ mode: 'interactive' }, { mode: 'auto' }],
          models: ['model-one'],
          defaultModel: 'model-one',
        }),
        mintSequence(),
      ),
    );

    // Assert
    should(actual).match(/names the "default" lane twice/u);
  });

  it('should refuse a lane this fleet does not declare even when another lane is fine', () => {
    // Act
    const actual = refusalOf(() =>
      applyFleetMutation(
        configOf(),
        bothLanes({ lanes: [{ variant: 'default' }, { variant: 'turbo' }] }),
        mintSequence(),
      ),
    );

    // Assert
    should(actual).match(/does not declare a "turbo" lane/u);
  });

  it('should refuse an incoherent availability once, for the whole create', () => {
    // Act — models, the default model and availability are the ACCOUNT's, not the lane's, so every
    // account this pass creates would carry the same defect and one sentence describes all of them.
    const actual = refusalOf(() =>
      applyFleetMutation(configOf(), bothLanes({ defaultModel: 'model-nine' }), mintSequence()),
    );

    // Assert
    should(actual).match(/"model-nine" is not one of the models this account lists/u);
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

describe('applyFleetMutation refusing to orphan a store item', () => {
  /** One store item, selected by the one account, so any change dropping it is observable. */
  const withStore = (store: Record<string, string>, selection: readonly string[]): FleetConfig =>
    configOf({
      shared: { skills: store },
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
              layer: { skills: selection },
            },
          },
        },
      ],
    });

  it('should refuse a change that stops offering a selected item, naming the accounts on it', () => {
    // Arrange — the store drops `review` while the account still selects it.
    const before = withStore({ review: 'skills/review' }, ['skills/review']);
    const after = withStore({}, ['skills/review']);

    // Act / Assert — the account id, the item name and its path, so the refusal says who to move and
    // what off. No verb removes a store item yet; the guard on the mutation path is what makes the verb
    // that does unable to arrive without it.
    should(refusalOf(() => assertNoOrphanedSharedDocuments(before, after))).match(
      new RegExp(`stop offering shared skills "review" \\(skills/review\\), used by ${ID_ONE}`, 'u'),
    );
  });

  it('should accept a change that leaves every offer in place', () => {
    // Arrange
    const config = withStore({ review: 'skills/review' }, ['skills/review']);

    // Act / Assert — the guard every mutation passes through must be silent on the ordinary case.
    should(() => assertNoOrphanedSharedDocuments(config, config)).not.throw();
  });

  it('should let every ordinary verb through, because none of them removes an offer', () => {
    // Arrange
    const config = withStore({ review: 'skills/review' }, ['skills/review']);

    // Act — an edit beside the selection keeps the store intact.
    const actual = applyFleetMutation(
      config,
      mutationOf({ kind: 'edit-account', accountId: ID_ONE, displayName: 'K' }),
      mintId,
    );

    // Assert
    should(actual.shared.skills).deepEqual({ review: 'skills/review' });
    should(routeOf(actual, ID_ONE).displayName).equal('K');
  });
});

describe('applyFleetMutation linking a shared skill', () => {
  const storeFleet = (): FleetConfig =>
    configOf({
      shared: { skills: { review: 'skills/review' } },
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
            },
          },
        },
      ],
    });

  it('should write the one-entry list a link means rather than a bare reference', () => {
    // Act
    const actual = applyFleetMutation(
      storeFleet(),
      mutationOf({ kind: 'link-shared-asset', accountId: ID_ONE, field: 'skills', name: 'review' }),
      mintId,
    );

    // Assert — the verb names one document, so it can only ever produce a selection of one, and the
    // stored configuration says so instead of leaving the schema to normalize a string.
    should((routeOf(actual, ID_ONE).layer as Record<string, unknown>).skills).deepEqual(['skills/review']);
  });

  it('should still write a bare reference for a field that holds one document', () => {
    // Arrange
    const config = configOf({
      shared: { memory: { default: './CLAUDE.md' } },
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
            },
          },
        },
      ],
    });

    // Act
    const actual = applyFleetMutation(
      config,
      mutationOf({ kind: 'link-shared-asset', accountId: ID_ONE, field: 'memory', name: 'default' }),
      mintId,
    );

    // Assert
    should((routeOf(actual, ID_ONE).layer as Record<string, unknown>).memory).equal('./CLAUDE.md');
  });
});

/**
 * A fleet with one login that already composes a profile, so a second account can be added to it.
 *
 * `existing()` above has no profiles, and the rules under test are all about what happens to a list
 * that is already there — which is the consequence a create can have on accounts nobody named.
 */
const withProfile = (): FleetConfig =>
  configOf({
    profiles: { work: { env: { ANTHROPIC_API_KEY: '${secret:WORK_KEY}' } } },
    agents: [
      {
        name: 'kirin',
        kind: 'claude',
        profiles: ['work'],
        routes: {
          default: {
            id: ID_ONE,
            wrapper: 'claude-kirin',
            home: 'claude-kirin',
            defaultModel: 'model-one',
            models: ['model-one'],
          },
        },
      },
    ],
  });

const agentOf = (config: FleetConfig, name: string): Record<string, unknown> => {
  const agent = config.agents.find(candidate => candidate.name === name);
  if (agent === undefined) throw new Error(`no agent ${name}`);
  return agent as unknown as Record<string, unknown>;
};

const createWithProfiles = (overrides: Record<string, unknown>): FleetMutation =>
  mutationOf({
    kind: 'create-account',
    harness: 'claude',
    name: 'kirin',
    ...oneLane('auto'),
    models: ['model-one'],
    defaultModel: 'model-one',
    ...overrides,
  });

describe('applyFleetMutation declaring a profile', () => {
  it('should fold the declaration into the configuration as an ordinary env map', () => {
    // Act
    const actual = applyFleetMutation(
      configOf(),
      createWithProfiles({
        ...oneLane(),
        declareProfiles: [
          {
            name: 'work',
            variables: [
              { from: 'secret', variable: 'ANTHROPIC_API_KEY', secret: 'WORK_KEY' },
              { from: 'environment', variable: 'HTTPS_PROXY', source: 'OUTER_PROXY' },
              { from: 'value', variable: 'ANTHROPIC_BASE_URL', value: 'https://gateway.invalid' },
            ],
          },
        ],
      }),
      mintId,
    );

    // Assert — the three spellings, composed by the fleet package's single producer of `${secret:…}`.
    // A whole-object comparison because a fourth key would mean a second kind of profile document.
    should(actual.profiles.work).deepEqual({
      env: {
        ANTHROPIC_API_KEY: '${secret:WORK_KEY}',
        HTTPS_PROXY: '$OUTER_PROXY',
        ANTHROPIC_BASE_URL: 'https://gateway.invalid',
      },
    });
  });

  it('should let one change declare a profile and name it, because declaring runs first', () => {
    // Arrange — the configuration schema cross-checks profile references, so a change that named a
    // profile it was adding in the same request would be an unknown name if the order were reversed.
    const mutation = createWithProfiles({
      ...oneLane(),
      profiles: ['work'],
      declareProfiles: [{ name: 'work', variables: [{ from: 'secret', variable: 'ANTHROPIC_API_KEY', secret: 'W' }] }],
    });

    // Act
    const actual = applyFleetMutation(configOf(), mutation, mintId);

    // Assert
    should(agentOf(actual, 'kirin').profiles).deepEqual(['work']);
    should(actual.profiles.work).deepEqual({ env: { ANTHROPIC_API_KEY: '${secret:W}' } });
  });

  it('should refuse a name this fleet already declares rather than writing over it', () => {
    // Arrange — the profile `claude-kirin` composes. Merging would re-credential an account this
    // change never names, from a request whose one-line summary says it adds an account.
    const config = withProfile();

    // Act
    const message = refusalOf(() =>
      applyFleetMutation(
        config,
        createWithProfiles({
          declareProfiles: [
            { name: 'work', variables: [{ from: 'secret', variable: 'ANTHROPIC_API_KEY', secret: 'OTHER_KEY' }] },
          ],
        }),
        mintId,
      ),
    );

    // Assert — and the remedy is in the sentence, so somebody can act on it without reading a doc.
    should(message).match(/already declares a profile named "work"/u);
    should(message).match(/name the existing one/u);
    should(config.profiles.work).deepEqual({ env: { ANTHROPIC_API_KEY: '${secret:WORK_KEY}' } });
  });

  it('should refuse one change that declares the same profile twice, because one name is one profile', () => {
    // Act
    const message = refusalOf(() =>
      applyFleetMutation(
        configOf(),
        createWithProfiles({
          ...oneLane(),
          declareProfiles: [
            { name: 'work', variables: [{ from: 'value', variable: 'ONE', value: 'a' }] },
            { name: 'work', variables: [{ from: 'value', variable: 'TWO', value: 'b' }] },
          ],
        }),
        mintId,
      ),
    );

    // Assert
    should(message).match(/declares the profile "work" twice/u);
  });

  it('should hold a declared profile name to the same rule a path component is held to', () => {
    // Arrange — a profile name is a key in the configuration and an argument in a sentence, and the
    // wire schema asks only for non-empty. The refusal comes from the same `SafeNameSchema` an account
    // name is parsed by, so a traversal spelling cannot reach the document at all.
    const act = (): unknown =>
      applyFleetMutation(
        configOf(),
        createWithProfiles({
          ...oneLane(),
          declareProfiles: [{ name: '../escape', variables: [{ from: 'value', variable: 'ONE', value: 'a' }] }],
        }),
        mintId,
      );

    // Act & Assert
    should(act).throw();
  });
});

describe('applyFleetMutation naming the profiles a created account composes', () => {
  it('should refuse a profile this fleet declares nothing of, naming it and what to do', () => {
    // Arrange — the configuration schema would catch it too, but its message names a path in a
    // document the caller never wrote. This is the difference between fixing a typo and reading
    // `agents.0.profiles.1`.
    const message = refusalOf(() =>
      applyFleetMutation(configOf(), createWithProfiles({ ...oneLane(), profiles: ['gateway'] }), mintId),
    );

    // Assert
    should(message).match(/declares no profile named "gateway"/u);
    should(message).match(/declare it with this change, or name one it has/u);
  });

  it('should refuse the same profile named twice, because a profile applies once wherever it sits', () => {
    // Act
    const message = refusalOf(() =>
      applyFleetMutation(withProfile(), createWithProfiles({ profiles: ['work', 'work'] }), mintId),
    );

    // Assert
    should(message).match(/names the profile "work" twice/u);
  });

  it('should leave an existing login’s profiles alone when the create names no list at all', () => {
    // Arrange — ABSENT IS NOT EMPTY. A second account added to `kirin` sends no `profiles`, and the
    // login keeps the one it composes; a create that sent `[]` here would strip the credential off an
    // account nobody in this request named.
    const config = withProfile();

    // Act
    const actual = applyFleetMutation(config, createWithProfiles({}), mintId);

    // Assert
    should(agentOf(actual, 'kirin').profiles).deepEqual(['work']);
  });

  it('should remove them when the create names an empty list, which is a declared "none"', () => {
    // Arrange — the other half of the same rule: `[]` is somebody answering "sign in" for this login.
    const config = withProfile();

    // Act
    const actual = applyFleetMutation(config, createWithProfiles({ profiles: [] }), mintId);

    // Assert
    should(agentOf(actual, 'kirin').profiles).deepEqual([]);
  });
});
