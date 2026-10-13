/**
 * Resolving the account a session start names.
 *
 * The claims: a wrapper name and an opaque id both resolve; an unreadable manifest refuses the start
 * rather than reading as an empty fleet; an unknown name, a terminal-only account and an account this
 * host cannot run each refuse with their own failure; any other inventory error is not swallowed.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import type { ExecutableResolverPort } from '../../../src/lib/core/harness-readiness.ts';
import {
  type AccountInventoryPort,
  type CoreAccount,
  FleetManifestUnreadableError,
} from '../../../src/lib/core/inventory.ts';
import { resolveStartAccount } from '../../../src/lib/fleet/start-resolution.ts';
import { SessionControlError } from '../../../src/lib/runtime/mounts/session-control.ts';

/** One published account, as the fleet manifest declares it. */
function account(patch: Partial<CoreAccount> = {}): CoreAccount {
  const agent = patch.agent ?? 'claude-auto-one';
  return {
    secretEnv: {},
    id: 'account-1',
    agent,
    wrapper: `/state/fleet/bin/${agent}`,
    home: `/state/fleet/homes/${agent}`,
    kind: 'claude',
    mode: 'auto',
    displayName: 'Claude auto one',
    defaultModel: null,
    models: [],
    available: true,
    unavailableReason: null,
    ...patch,
  };
}

function inventory(...accounts: readonly CoreAccount[]): AccountInventoryPort {
  return { accounts: async () => accounts };
}

function failingInventory(error: Error): AccountInventoryPort {
  return {
    accounts: async () => {
      throw error;
    },
  };
}

/** A host that can run exactly the named wrapper paths. */
function hostRunning(...paths: readonly string[]): ExecutableResolverPort {
  return { resolve: () => undefined, runnable: path => paths.includes(path) };
}

async function refusal(work: Promise<unknown>): Promise<SessionControlError> {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  should(error).be.instanceOf(SessionControlError);
  return error as SessionControlError;
}

describe('resolveStartAccount', () => {
  const auto = account();
  const host = hostRunning(auto.wrapper);

  it('should resolve an account by its wrapper name', async () => {
    // Act
    const resolved = await resolveStartAccount(inventory(auto), 'claude-auto-one', host, 'fy');

    // Assert
    should(resolved).deepEqual({ account: auto, executable: auto.wrapper });
  });

  it('should resolve an account by its opaque id', async () => {
    // Act
    const resolved = await resolveStartAccount(inventory(auto), 'account-1', host, 'fy');

    // Assert
    should(resolved.account).equal(auto);
  });

  it('should refuse as unavailable when the manifest is present and unreadable', async () => {
    // Arrange
    const damaged = failingInventory(new FleetManifestUnreadableError('/state/fleet/manifest.json', 'bad row'));

    // Act
    const error = await refusal(resolveStartAccount(damaged, 'claude-auto-one', host, 'fy'));

    // Assert
    should(error.failure).equal('unavailable');
    should(error.message).match(/manifest\.json is present but cannot be read: bad row/u);
    should(error.message).match(/run `fy fleet apply`/u);
  });

  it('should rethrow any other inventory failure unchanged', async () => {
    // Arrange
    const boom = new Error('disk on fire');

    // Act
    const error = await resolveStartAccount(failingInventory(boom), 'claude-auto-one', host, 'fy').then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    // Assert
    should(error).equal(boom);
  });

  it('should refuse an agent no account is published as', async () => {
    // Act
    const error = await refusal(resolveStartAccount(inventory(auto), 'claude-auto-nobody', host, 'fy'));

    // Assert
    should(error.failure).equal('unknown_agent');
    should(error.message).equal('no account in the fleet manifest is published as "claude-auto-nobody"');
  });

  it('should refuse a terminal-only account as invalid, naming the account that can run it', async () => {
    // Arrange
    const interactive = account({ id: 'account-2', agent: 'claude-default', mode: 'interactive' });

    // Act
    const error = await refusal(resolveStartAccount(inventory(interactive, auto), 'claude-default', host, 'fy'));

    // Assert
    should(error.failure).equal('invalid');
    should(error.message).match(/Start it on claude-auto-one instead/u);
  });

  it('should refuse as unavailable an account this host cannot run', async () => {
    // Act
    const error = await refusal(resolveStartAccount(inventory(auto), 'claude-auto-one', hostRunning(), 'fy'));

    // Assert
    should(error.failure).equal('unavailable');
    should(error.message).match(/this host cannot run that file/u);
  });
});

describe('resolveStartAccount by a runtime name it had before', () => {
  const RUNTIME_ID = '00000000-0000-4000-8000-0000000000aa';
  const renamed = account({ id: RUNTIME_ID, agent: 'reviewer' });
  const host = hostRunning(renamed.wrapper);
  const ids = {
    version: 1 as const,
    runtimes: { reviewer: { id: RUNTIME_ID, formerNames: ['claude-auto-review'] } },
  };
  const withIds = (read: () => Promise<typeof ids | undefined>) => ({ ...inventory(renamed), ids: read });

  it('should resolve an old wrapper name to the runtime it became', async () => {
    // Act
    const actual = await resolveStartAccount(withIds(async () => ids), 'claude-auto-review', host, 'fy');

    // Assert
    should(actual.account.agent).equal('reviewer');
  });

  it('should still resolve a name and an id without reading the runtime ids', async () => {
    // Arrange
    let reads = 0;
    const counted = withIds(async () => {
      reads++;
      return ids;
    });

    // Act
    const byName = await resolveStartAccount(counted, 'reviewer', host, 'fy');
    const byId = await resolveStartAccount(withIds(async () => undefined), RUNTIME_ID, host, 'fy');

    // Assert
    should(byName.account.id).equal(RUNTIME_ID);
    should(byId.account.id).equal(RUNTIME_ID);
    should(reads).equal(0);
  });

  it('should refuse as unknown a name that is neither current nor former', async () => {
    // Act
    const error = await refusal(resolveStartAccount(withIds(async () => ids), 'nobody', host, 'fy'));

    // Assert
    should(error.failure).equal('unknown_agent');
  });

  it('should refuse as unavailable when the runtime ids cannot be read, unless the request is an id', async () => {
    // Arrange
    const broken = withIds(async () => {
      throw new Error('ids.json is damaged');
    });

    // Act
    const error = await refusal(resolveStartAccount(broken, 'claude-auto-review', host, 'fy'));
    const byId = await resolveStartAccount(broken, RUNTIME_ID, host, 'fy');

    // Assert
    should(error.failure).equal('unavailable');
    should(error.message).match(/ids\.json is damaged/u);
    should(byId.account.agent).equal('reviewer');
  });

  it('should not follow a former name to a runtime the manifest does not publish', async () => {
    // Arrange — ids.json knows the runtime; the manifest has not published it yet.
    const unpublished = { ...inventory(), ids: async () => ids };

    // Act
    const error = await refusal(resolveStartAccount(unpublished, 'claude-auto-review', host, 'fy'));

    // Assert
    should(error.failure).equal('unknown_agent');
  });
});
