import { describe, it } from 'bun:test';
import should from 'should';
import {
  FleetManifestAccountSchema,
  FleetManifestModelSchema,
  FleetManifestSchema,
  MANIFEST_VERSION,
  availableAccounts,
  buildFleetManifest,
  findAccountById,
  isModelSelectable,
  selectableModelIds,
  wrapperName,
} from '../../src/lib/manifest.ts';
import type { FleetManifestAccount } from '../../src/lib/manifest.ts';

const ID_ONE = '00000000-0000-4000-8000-000000000001';
const ID_TWO = '00000000-0000-4000-8000-000000000002';
const GENERATED_AT = '2027-01-15T08:00:00.000Z';

const account = (overrides: Partial<FleetManifestAccount> = {}): FleetManifestAccount => ({
  secretEnv: {},
  id: ID_ONE,
  kind: 'claude',
  mode: 'auto',
  wrapper: '/state/fleet/bin/crc-auto-atomi',
  home: '/state/fleet/homes/auto-atomi',
  displayName: 'Atomi (auto)',
  defaultModel: 'model-one',
  models: [{ id: 'model-one', displayName: 'Model One', available: true }],
  available: true,
  unavailableReason: null,
  ...overrides,
});

const messagesOf = (input: unknown): string[] => {
  const parsed = FleetManifestAccountSchema.safeParse(input);
  return parsed.success ? [] : parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`);
};

describe('FleetManifestModelSchema', () => {
  it('should accept an available model without a reason and a down model with one', () => {
    // Act + Assert
    should(FleetManifestModelSchema.safeParse({ id: 'model-one', available: true }).success).be.true();
    should(
      FleetManifestModelSchema.safeParse({ id: 'model-one', available: false, unavailableReason: 'quota' }).success,
    ).be.true();
  });

  it('should reject a down model with no reason and an available model that carries one', () => {
    // Act + Assert
    should(FleetManifestModelSchema.safeParse({ id: 'model-one', available: false }).success).be.false();
    should(
      FleetManifestModelSchema.safeParse({ id: 'model-one', available: true, unavailableReason: 'quota' }).success,
    ).be.false();
  });

  it('should require availability to be stated rather than assumed', () => {
    // Act
    const actual = FleetManifestModelSchema.safeParse({ id: 'model-one' });

    // Assert
    should(actual.success).be.false();
  });
});

describe('FleetManifestAccountSchema', () => {
  it('should accept a coherent account', () => {
    // Act
    const actual = messagesOf(account());

    // Assert
    should(actual).deepEqual([]);
  });

  it.each([
    ['hyphen heavy', '/state/fleet/bin/claude-auto-glm52a'],
    ['alias shaped, harness prefix absent', '/state/fleet/bin/crc-auto-atomi'],
    ['looks like the other harness', '/state/fleet/bin/codex-auto-kirin'],
  ])('should accept a claude account whose wrapper path reads as %s', (_label, wrapper) => {
    // Arrange — nothing may be inferred from a wrapper path, so any shape must be accepted
    const input = account({ kind: 'claude', wrapper });

    // Act
    const parsed = FleetManifestAccountSchema.safeParse(input);

    // Assert
    should(parsed.success).be.true();
    should(parsed.data?.kind).equal('claude');
  });

  it('should reject an account that is down without saying why', () => {
    // Act
    const actual = messagesOf(account({ available: false, unavailableReason: null }));

    // Assert
    should(actual).matchAny(/must state an unavailableReason/);
  });

  it('should reject an available account that carries a reason', () => {
    // Act
    const actual = messagesOf(account({ unavailableReason: 'stale' }));

    // Assert
    should(actual).matchAny(/must not carry an unavailableReason/);
  });

  it('should reject a defaultModel the account declares unavailable', () => {
    // Arrange — config said this model is down; the manifest must not be able to default to it
    const input = account({
      defaultModel: 'model-down',
      models: [
        { id: 'model-down', available: false, unavailableReason: 'every credential returns 429' },
        { id: 'model-up', available: true },
      ],
    });

    // Act
    const actual = messagesOf(input);

    // Assert
    should(actual).matchAny(/declared unavailable \(every credential returns 429\)/);
  });

  it('should reject a defaultModel that is not among the account models', () => {
    // Act
    const actual = messagesOf(account({ defaultModel: 'ghost' }));

    // Assert
    should(actual).matchAny(/is not one of this account's models/);
  });

  it('should reject an available account with no defaultModel', () => {
    // Act
    const actual = messagesOf(account({ defaultModel: null }));

    // Assert
    should(actual).matchAny(/must name a defaultModel/);
  });

  it('should reject a duplicated model', () => {
    // Act
    const actual = messagesOf(
      account({
        models: [
          { id: 'model-one', available: true },
          { id: 'model-one', available: true },
        ],
      }),
    );

    // Assert
    should(actual).matchAny(/duplicate model "model-one"/);
  });

  it('should reject an unknown field', () => {
    // Act
    const actual = messagesOf({ ...account(), provider: 'anthropic' });

    // Assert
    should(actual.length).be.above(0);
  });
});

describe('selectableModelIds', () => {
  it('should offer only the models an available account declares available', () => {
    // Arrange
    const subject = account({
      defaultModel: 'model-up',
      models: [
        { id: 'model-up', available: true },
        { id: 'model-down', available: false, unavailableReason: 'quota exhausted' },
      ],
    });
    const expected = ['model-up'];

    // Act
    const actual = selectableModelIds(subject);

    // Assert
    should(actual).deepEqual(expected);
    should(isModelSelectable(subject, 'model-down')).be.false();
    should(isModelSelectable(subject, 'model-up')).be.true();
  });

  it('should offer nothing at all from an unavailable account', () => {
    // Arrange — a down account cannot serve even a model it lists as available
    const subject = account({ available: false, unavailableReason: 'provider maintenance' });

    // Act
    const actual = selectableModelIds(subject);

    // Assert
    should(actual).deepEqual([]);
    should(isModelSelectable(subject, 'model-one')).be.false();
  });
});

describe('FleetManifestSchema', () => {
  const manifest = (accounts: readonly FleetManifestAccount[]): unknown => ({
    version: MANIFEST_VERSION,
    generatedAt: GENERATED_AT,
    accounts,
  });

  it('should accept two distinct accounts', () => {
    // Arrange
    const input = manifest([
      account(),
      account({ id: ID_TWO, wrapper: '/state/fleet/bin/codex-loge', home: '/state/fleet/homes/loge' }),
    ]);

    // Act
    const parsed = FleetManifestSchema.safeParse(input);

    // Assert
    should(parsed.success).be.true();
    should(parsed.data?.accounts.length).equal(2);
  });

  it.each([
    ['id', {}, /duplicate account id/],
    ['wrapper', { id: ID_TWO, home: '/state/fleet/homes/other' }, /duplicate wrapper name/],
    ['home', { id: ID_TWO, wrapper: '/state/fleet/bin/other' }, /duplicate home directory/],
  ])('should reject a duplicated %s', (_label, overrides, pattern) => {
    // Arrange
    const input = manifest([account(), account(overrides as Partial<FleetManifestAccount>)]);

    // Act
    const parsed = FleetManifestSchema.safeParse(input);
    const actual = parsed.success ? [] : parsed.error.issues.map(issue => issue.message);

    // Assert
    should(actual).matchAny(pattern);
  });

  it('should reject an unrecognized version and a non-instant timestamp', () => {
    // Act + Assert
    should(FleetManifestSchema.safeParse({ version: 2, generatedAt: GENERATED_AT, accounts: [] }).success).be.false();
    should(FleetManifestSchema.safeParse({ version: 1, generatedAt: 'yesterday', accounts: [] }).success).be.false();
  });
});

describe('buildFleetManifest', () => {
  it('should stamp the current version and return a parsed manifest', () => {
    // Arrange
    const input = { generatedAt: GENERATED_AT, accounts: [account()] };

    // Act
    const actual = buildFleetManifest(input);

    // Assert
    should(actual.version).equal(MANIFEST_VERSION);
    should(actual.generatedAt).equal(GENERATED_AT);
    should(findAccountById(actual, ID_ONE)?.displayName).equal('Atomi (auto)');
    should(findAccountById(actual, ID_TWO)).be.undefined();
  });

  it('should throw rather than publish a contradictory account', () => {
    // Arrange
    const input = {
      generatedAt: GENERATED_AT,
      accounts: [
        account({
          defaultModel: 'model-down',
          models: [{ id: 'model-down', available: false, unavailableReason: 'quota' }],
        }),
      ],
    };

    // Act + Assert
    should(() => buildFleetManifest(input)).throw(/declared unavailable/);
  });

  it('should keep an unavailable account listed but out of the available set', () => {
    // Arrange
    const down = account({
      id: ID_TWO,
      wrapper: '/state/fleet/bin/claude-loge',
      home: '/state/fleet/homes/loge',
      available: false,
      unavailableReason: 'pool exhausted',
    });

    // Act
    const actual = buildFleetManifest({ generatedAt: GENERATED_AT, accounts: [account(), down] });

    // Assert
    should(actual.accounts.length).equal(2);
    should(availableAccounts(actual).map(entry => entry.id)).deepEqual([ID_ONE]);
  });
});

describe('wrapperName', () => {
  it('should recover the executable name a person types from the published path', () => {
    // Arrange / Act / Assert
    should(wrapperName(account())).equal('crc-auto-atomi');
  });

  it('should answer the whole value when the manifest publishes a bare name', () => {
    // Arrange / Act / Assert — nothing here reassembles a path, so a bare wrapper is its own name
    should(wrapperName(account({ wrapper: 'crc-auto-atomi' }))).equal('crc-auto-atomi');
  });
});
