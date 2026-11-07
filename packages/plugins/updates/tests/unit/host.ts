/** A fake `UpdateHost` for the daemon tests: no file system, no process, no network. */
import type { UpdateHost } from '../../daemon/lib/host.ts';

export const STORE = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-ferretry-4.28.0';
export const HOME = '/home/kirin';

export function fakeHost(overrides: Partial<UpdateHost> = {}): UpdateHost & { readonly launched: string[] } {
  const launched: string[] = [];
  return {
    version: '4.28.0',
    product: 'ferretry',
    clientName: 'fy',
    daemonName: 'fyd',
    checks: true,
    argv0: `${HOME}/.nix-profile/bin/fyd`,
    execPath: `${STORE}/bin/fyd`,
    main: '/$bunfs/root/fyd',
    homeDirectory: HOME,
    platform: 'linux',
    workingDirectory: '/work',
    which: () => undefined,
    realpath: async path => path,
    readLink: async () => undefined,
    files: { report: '/state/update/report.json', log: '/state/update.log' },
    launchUpdate: async target => {
      launched.push(target);
    },
    launched,
    ...overrides,
  };
}
