import { describe, it } from 'bun:test';
import should from 'should';
import { loginOrganizationType } from '../../../daemon/lib/login-organization-type.ts';

const logins = (
  stores: readonly { id: string; variables: Record<string, string>; organizationType?: string }[],
  views: Record<string, { store: string; harness: string }>,
) =>
  ({
    launchStores: async () => stores,
    get: async (id: string) => views[id],
  }) as never;

describe('the organisation type of the login a launch spends', () => {
  it('should read a Ferretry-kept login’s type from what Logins names for it, never the host file', async () => {
    const found = await loginOrganizationType(
      logins([{ id: 'work', variables: {}, organizationType: 'claude_enterprise' }], {
        work: { store: 'ferretry', harness: 'claude-code' },
      }),
      async () => {
        throw new Error('the host file must not be read for a Ferretry-kept login');
      },
      'work',
    );

    should(found).equal('claude_enterprise');
  });

  it('should read a host-kept Claude login’s type from the person’s own file (store: host, claude_max → on)', async () => {
    const found = await loginOrganizationType(
      logins([{ id: 'host', variables: {} }], { host: { store: 'host', harness: 'claude-code' } }),
      async () => 'claude_max',
      'host',
    );

    should(found).equal('claude_max');
  });

  it('should answer nothing for an environment login, a Codex login and an id Logins does not know, and never read the host file for them', async () => {
    const readHost = async () => {
      throw new Error('not for this login');
    };
    const world = logins([], {
      env: { store: 'environment', harness: 'claude-code' },
      codex: { store: 'host', harness: 'codex' },
    });

    should(await loginOrganizationType(world, readHost, 'env')).be.undefined();
    should(await loginOrganizationType(world, readHost, 'codex')).be.undefined();
    should(await loginOrganizationType(world, readHost, 'ghost')).be.undefined();
  });

  it('should answer nothing for a host-kept login whose file names no type', async () => {
    const found = await loginOrganizationType(
      logins([], { host: { store: 'host', harness: 'claude-code' } }),
      async () => undefined,
      'host',
    );

    should(found).be.undefined();
  });
});
