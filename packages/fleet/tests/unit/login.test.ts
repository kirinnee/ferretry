import { describe, it } from 'bun:test';
import should from 'should';
import { type FleetLoginOutcome, FleetLoginService, UnknownFleetAccountError } from '../../src/lib/login.ts';
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
