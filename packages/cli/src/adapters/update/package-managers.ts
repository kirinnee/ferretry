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

  /** Make brew see the newest cask: tap it if it is gone, then `brew update`. Auto-update may not have run for a day. */
  async brewRefresh(tap: string, url: string): Promise<CommandOutcome> {
    const tapped = await this.run(['brew', 'tap']);
    if (tapped.code === 0 && !tapped.stdout.split('\n').some(line => line.trim() === tap)) {
      const added = await this.run(['brew', 'tap', tap, url]);
      if (added.code !== 0) return added;
    }
    return this.run(['brew', 'update']);
  }

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
