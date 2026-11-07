import { describe, expect, test } from 'bun:test';
import type { PathsPort } from '../../../contract/ports.ts';
import type { AppContext, CliContext, DaemonContext } from '../../../manifest/implement.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { testHost } from '../../../testing/index.ts';

const manifest = definePlugin({ id: 'accounts', title: 'Accounts', version: '5.0.0', api: 5, core: false, kinds: [] });

describe('KK kernel.paths.home(): the owner home, on daemon halves only', () => {
  test('a daemon half reads the host home through kernel.paths', async () => {
    let seen = '';
    const half = implementDaemon(manifest, {
      build: ctx => {
        seen = ctx.kernel.paths.home();
        return {};
      },
    });
    const host = await testHost({ plugins: [half], ownerHome: '/Users/owner' });
    expect(seen).toBe('/Users/owner');
    await host.stop();
  });

  test('the CLI and app contexts carry no kernel ports, so no paths', () => {
    type HasPaths<C> = C extends { readonly kernel: { readonly paths: PathsPort } } ? true : false;
    const daemon: HasPaths<DaemonContext<typeof manifest>> = true;
    const cli: HasPaths<CliContext<typeof manifest>> = false;
    const app: HasPaths<AppContext<typeof manifest>> = false;
    expect([daemon, cli, app]).toEqual([true, false, false]);
  });
});
