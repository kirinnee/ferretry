import { describe, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { diskFolders } from '@ferretry/kernel/testing';
import should from 'should';
import { hostOrganizationType } from '../../../daemon/adapters/host-organization-type.ts';

async function withHome(text: string | undefined, run: (home: string, roots: { root: never }) => Promise<void>) {
  const parent = await mkdtemp(`${tmpdir()}/orgtype-`);
  try {
    const folders = await diskFolders(parent);
    const home = `${parent}/user`;
    await Bun.$`mkdir -p ${home}`.quiet();
    if (text !== undefined) await writeFile(`${home}/.claude.json`, text);
    await run(home, { root: ((_name: string, scope: { subfolder: string }) => folders(scope.subfolder)) as never });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

describe('the organisation type of a host-kept Claude login', () => {
  it('reads the one non-secret field of ~/.claude.json and nothing else', async () => {
    await withHome(
      JSON.stringify({ oauthAccount: { organizationType: 'claude_max', emailAddress: 'a@b.c' }, other: 'x' }),
      async (home, roots) => {
        should(await hostOrganizationType(roots, home)).equal('claude_max');
      },
    );
  });

  it('answers nothing for an absent file, a malformed one, a missing account or a field that is not a string', async () => {
    await withHome(undefined, async (home, roots) => {
      should(await hostOrganizationType(roots, home)).be.undefined();
    });
    await withHome('{ not json', async (home, roots) => {
      should(await hostOrganizationType(roots, home)).be.undefined();
    });
    await withHome('{}', async (home, roots) => {
      should(await hostOrganizationType(roots, home)).be.undefined();
    });
    await withHome('null', async (home, roots) => {
      should(await hostOrganizationType(roots, home)).be.undefined();
    });
    await withHome(JSON.stringify({ oauthAccount: { organizationType: 5 } }), async (home, roots) => {
      should(await hostOrganizationType(roots, home)).be.undefined();
    });
    await withHome(JSON.stringify({ oauthAccount: { organizationType: '' } }), async (home, roots) => {
      should(await hostOrganizationType(roots, home)).be.undefined();
    });
  });

  it('answers nothing for a home it cannot place', async () => {
    const roots = {
      root: () => ({ resolve: () => ({ ok: false, error: 'outside' }) }),
    } as never;
    should(await hostOrganizationType(roots, '/x')).be.undefined();
  });

  it('answers nothing when the file is larger than a Claude account file can be', async () => {
    await withHome(`{"pad":"${'x'.repeat(5 * 1024 * 1024)}"}`, async (home, roots) => {
      should(await hostOrganizationType(roots, home)).be.undefined();
    });
  });
});
