import type { CommandOutcome } from '../../lib/daemon/ports.ts';
import type { IPackageManagerPort } from '../../lib/update/ports.ts';

/** The experimental features every `nix profile` command needs, named so no host's config decides. */
const NIX = ['nix', '--extra-experimental-features', 'nix-command flakes'] as const;

/**
 * The package-manager commands a self-update runs, as the user, never with `sudo`.
 *
 * `--refresh` on the nix commands is the difference between an update and a no-op: an unlocked
 * `github:` reference is cached for an hour, so without it `nix profile upgrade` reinstalls the
 * version it already has and reports success.
 */
export class CommandPackageManagers implements IPackageManagerPort {
  constructor(private readonly run: (argv: readonly string[]) => Promise<CommandOutcome>) {}

  brewUpgrade(cask: string): Promise<CommandOutcome> {
    return this.run(['brew', 'upgrade', '--cask', cask]);
  }

  nixProfileUpgrade(element: string): Promise<CommandOutcome> {
    return this.run([...NIX, 'profile', 'upgrade', '--refresh', element]);
  }

  nixProfileRollback(): Promise<CommandOutcome> {
    return this.run([...NIX, 'profile', 'rollback']);
  }

  nixProfileInstall(flake: string): Promise<CommandOutcome> {
    return this.run([...NIX, 'profile', 'install', '--refresh', flake]);
  }
}
