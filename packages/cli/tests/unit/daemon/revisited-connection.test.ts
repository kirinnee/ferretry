import { describe, it } from 'bun:test';
import { DAEMON_FEATURES } from '@ferretry/protocol';
import should from 'should';
import { type DecidedConnection, RevisitedConnection } from '../../../src/adapters/daemon/session-credential.ts';

/**
 * `fy mcp serve` holds one connection for the life of the pane (docs/agent-tools.md § "The ferret session
 * credential"). A decision that FAILED — the daemon away, the listener check or the `api-token` read
 * throwing — must not be that connection: the next call decides again (secrev-1243 N1).
 */
describe('a long-lived connection whose decision failed', () => {
  const OFFERS = { pid: 2, features: [DAEMON_FEATURES.sessionCredential] };

  function deciding(outcomes: ReadonlyArray<() => DecidedConnection<string>>): {
    readonly connection: RevisitedConnection<string>;
    readonly decisions: () => number;
    now: number;
  } {
    let decisions = 0;
    const state = { now: 0 };
    const connection = new RevisitedConnection<string>(
      async () => {
        const outcome = outcomes[Math.min(decisions, outcomes.length - 1)];
        decisions += 1;
        if (outcome === undefined) throw new Error('no outcome');
        return outcome();
      },
      async () => OFFERS,
      () => state.now,
      1_000,
    );
    return Object.assign(state, { connection, decisions: () => decisions });
  }

  const fails = (): DecidedConnection<string> => {
    throw new Error('daemon away');
  };

  it('should decide again on the next call after a first decision failed', async () => {
    const fixture = deciding([fails, () => ({ client: 'bearer' })]);

    await should(fixture.connection.client()).be.rejectedWith('daemon away');
    should(await fixture.connection.client()).equal('bearer');
    should(fixture.decisions()).equal(2);
  });

  it('should decide again after a fresh decision that followed a look failed', async () => {
    const fixture = deciding([
      () => ({ client: 'admin', revisit: { baseUrl: 'http://127.0.0.1:1', pid: 1 } }),
      fails,
      () => ({ client: 'bearer' }),
    ]);
    should(await fixture.connection.client()).equal('admin');
    fixture.now = 1_000;

    await should(fixture.connection.client()).be.rejectedWith('daemon away');
    should(await fixture.connection.client()).equal('bearer');
    should(fixture.decisions()).equal(3);
  });

  it('should keep a decision that succeeded, deciding only once', async () => {
    const fixture = deciding([() => ({ client: 'bearer' })]);

    await fixture.connection.client();
    await fixture.connection.client();
    should(fixture.decisions()).equal(1);
  });
});
