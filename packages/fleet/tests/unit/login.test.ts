import { describe, it } from 'bun:test';
import should from 'should';
import { type FleetConfig, FleetConfigSchema } from '../../src/lib/config.ts';
import {
  type FleetLoginOutcome,
  FleetLoginService,
  requiresProviderLogin,
  UnknownFleetAccountError,
} from '../../src/lib/login.ts';
import type { FleetManifest, FleetManifestAccount } from '../../src/lib/manifest.ts';

const account = (overrides: Partial<FleetManifestAccount> = {}): FleetManifestAccount => ({
  id: '00000000-0000-4000-8000-000000000001',
  kind: 'claude',
  mode: 'auto',
  wrapper: '/tmp/fy-test/bin/route-one',
  home: '/tmp/fy-test/homes/one',
  displayName: 'Route One',
  defaultModel: 'model-one',
  models: [{ id: 'model-one', displayName: 'Model One', available: true }],
  available: true,
  unavailableReason: null,
  ...overrides,
});

const manifest = (accounts: readonly FleetManifestAccount[]): FleetManifest => ({
  version: 1,
  generatedAt: '2027-01-15T08:00:00.000Z',
  accounts,
});

describe('FleetLoginService', () => {
  it('should execute selected accounts by opaque id without inspecting wrapper attributes', async () => {
    // Arrange
    const calls: string[] = [];
    const subject = new FleetLoginService({
      async login(value): Promise<FleetLoginOutcome> {
        calls.push(value.id);
        return { status: 'logged-in' };
      },
    });
    const target = account({ wrapper: '/tmp/fy-test/bin/alias-with-many-hyphens' });

    // Act
    const actual = await subject.login(manifest([target]), [target.id]);

    // Assert
    should(calls).deepEqual([target.id]);
    should(actual).deepEqual([{ accountId: target.id, status: 'logged-in' }]);
  });

  it('should skip manifest-declared unavailable accounts', async () => {
    // Arrange
    let calls = 0;
    const subject = new FleetLoginService({
      async login(): Promise<FleetLoginOutcome> {
        calls += 1;
        return { status: 'logged-in' };
      },
    });
    const target = account({
      available: false,
      unavailableReason: 'provider maintenance',
      defaultModel: null,
      models: [],
    });

    // Act
    const actual = await subject.login(manifest([target]));

    // Assert
    should(calls).equal(0);
    should(actual).deepEqual([{ accountId: target.id, status: 'unavailable', message: 'provider maintenance' }]);
  });

  it('should turn port exceptions into per-account failures and continue', async () => {
    // Arrange
    const first = account();
    const second = account({ id: '00000000-0000-4000-8000-000000000002' });
    const subject = new FleetLoginService({
      async login(value): Promise<FleetLoginOutcome> {
        if (value.id === first.id) {
          throw new Error('browser login failed');
        }
        return { status: 'not-required' };
      },
    });

    // Act
    const actual = await subject.login(manifest([second, first]));

    // Assert
    should(actual).deepEqual([
      { accountId: first.id, status: 'failed', message: 'browser login failed' },
      { accountId: second.id, status: 'not-required' },
    ]);
  });

  it('should reject an unknown account id instead of matching another attribute', async () => {
    // Arrange
    const subject = new FleetLoginService({
      async login(): Promise<FleetLoginOutcome> {
        return { status: 'logged-in' };
      },
    });

    // Act
    const promise = subject.login(manifest([account()]), ['alias-with-many-hyphens']);

    // Assert
    await should(promise).be.rejectedWith(UnknownFleetAccountError);
  });
});

describe('requiresProviderLogin', () => {
  const ID_OAUTH = '00000000-0000-4000-8000-00000000a001';
  const ID_KEY = '00000000-0000-4000-8000-00000000a002';

  const route = (id: string, wrapper: string, home: string): Record<string, unknown> => ({
    id,
    wrapper,
    home,
    defaultModel: 'opus',
    models: ['opus'],
  });

  const config = (): FleetConfig =>
    FleetConfigSchema.parse({
      agents: [
        { name: 'work', kind: 'claude', routes: { default: route(ID_OAUTH, 'fy-claude-work', '~/.claude-work') } },
        {
          name: 'proxy',
          kind: 'claude',
          auth: 'api-key',
          routes: { default: route(ID_KEY, 'fy-claude-proxy', '~/.claude-proxy') },
        },
      ],
    });

  it('should require a login for a declared OAuth account', () => {
    // Act
    const actual = requiresProviderLogin(config())(account({ id: ID_OAUTH }));

    // Assert
    should(actual).be.true();
  });

  it('should skip an account the configuration declares key-authenticated', () => {
    // Act
    const actual = requiresProviderLogin(config())(account({ id: ID_KEY }));

    // Assert
    should(actual).be.false();
  });

  it('should require a login for an account the configuration no longer mentions', () => {
    // Act — a manifest can outlive its configuration; attempting costs one refusal, skipping
    // leaves the fleet signed out with nothing said.
    const actual = requiresProviderLogin(config())(account({ id: '00000000-0000-4000-8000-00000000a999' }));

    // Assert
    should(actual).be.true();
  });
});
