/** A fake `InstallHost` over a fake kernel `UpdateHostPort` for the daemon tests: no file system, no process, no network. */
import type { ExecutableFacts, UpdateHostPort } from '@ferretry/kernel/contract';
import type { InstallHost } from '../../daemon/lib/host.ts';

export const STORE = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-ferretry-4.28.0';
export const HOME = '/home/kirin';

export interface FakeHostOptions extends Partial<ExecutableFacts> {
  readonly compiled?: boolean;
  readonly checks?: boolean;
  readonly release?: string;
  readonly homeDirectory?: string;
  readonly which?: (name: string) => string | undefined;
  readonly launch?: UpdateHostPort['launchUpdate'];
}

export function fakeHost(overrides: FakeHostOptions = {}): InstallHost & { readonly launched: string[] } {
  const launched: string[] = [];
  const executable: ExecutableFacts = {
    argv0: `${HOME}/.nix-profile/bin/fyd`,
    execPath: `${STORE}/bin/fyd`,
    resolvedExecPath: overrides.resolvedExecPath ?? overrides.execPath ?? `${STORE}/bin/fyd`,
    main: '/$bunfs/root/fyd',
    workingDirectory: '/work',
    platform: 'linux',
    ...overrides,
  };
  const port: UpdateHostPort = {
    release: overrides.release ?? '4.28.0',
    compiled: overrides.compiled ?? executable.main.startsWith('/$bunfs/'),
    checks: overrides.checks ?? overrides.compiled ?? executable.main.startsWith('/$bunfs/'),
    executable: async () => executable,
    launchUpdate:
      overrides.launch ??
      (async target => {
        launched.push(target);
        return { kind: 'started' };
      }),
  };
  return {
    port,
    product: 'ferretry',
    homeDirectory: overrides.homeDirectory ?? HOME,
    which: overrides.which ?? (() => undefined),
    launched,
  };
}
