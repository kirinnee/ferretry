import { describe, it } from 'bun:test';
import should from 'should';
import { FleetCatalogRefusal } from '../../../daemon/lib/service/catalog-service.ts';
import { createLogins, type LoginEnvPlan } from '../../../daemon/lib/service/setup-login-env.ts';

type Catalog = Parameters<typeof createLogins>[0];

/** A plan creating one login `work`, with `secrets` already filed. */
const planOf = (secrets: readonly { name: string; value: string }[]): LoginEnvPlan => ({
  newLogins: [{ id: 'work', harness: 'claude', store: 'ferretry' }],
  secrets,
});

/** A catalogue whose Logins door holds no login yet and applies through `apply`. */
const catalogOf = (apply: (id: string) => Promise<unknown>): Catalog =>
  ({
    credentials: { list: async () => ({ logins: [] }) },
    loginChanges: {
      stage: async () => ({ id: 'staged-1' }),
      apply,
    },
  }) as unknown as Catalog;

describe('createLogins when Logins refuses to apply a staged login', () => {
  it('stops with a refusal naming the login, saying nothing else changed and that filed keys stay', async () => {
    let thrown: unknown;
    try {
      await createLogins(
        catalogOf(async () => {
          throw new Error('the login store is read-only');
        }),
        planOf([{ name: 'WORK_KEY', value: 'x' }]),
      );
    } catch (error) {
      thrown = error;
    }
    should(thrown).be.instanceOf(FleetCatalogRefusal);
    const refusal = thrown as FleetCatalogRefusal;
    should(refusal.code).equal('fleet_change_failed');
    should(refusal.message).equal(
      'Logins could not create the login work: the login store is read-only. Nothing else was changed; the keys already added to the secret store stay there.',
    );
  });

  it('leaves the keys sentence out when the apply filed none, and words a non-Error rejection', async () => {
    let thrown: unknown;
    try {
      await createLogins(
        catalogOf(async () => {
          throw 'plain refusal';
        }),
        planOf([]),
      );
    } catch (error) {
      thrown = error;
    }
    should(thrown).be.instanceOf(FleetCatalogRefusal);
    should((thrown as FleetCatalogRefusal).message).equal(
      'Logins could not create the login work: plain refusal. Nothing else was changed.',
    );
  });
});
