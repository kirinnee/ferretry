import {
  type HarnessFactsSource,
  type InstallFacts,
  parseNixProfileList,
  passesThroughHomeManagerPath,
  nixPathHops,
  symlinkHops,
} from '../lib/update/index.ts';
import type { HostPrograms } from './host-programs.ts';

/**
 * The facts about the file a runtime launches for Codex: its resolved path, its link chain, and the nix profile element
 * that holds it. `launchedPath` is what the resolution rule chose, which is what a session `exec`s.
 *
 * The link chain and the profile listing only decide anything for a file in the Nix store, so they are read only then —
 * the answer is the same, and a host without Nix pays for nothing.
 */
export class HostCodexFacts implements HarnessFactsSource {
  readonly #host: HostPrograms;

  constructor(host: HostPrograms) {
    this.#host = host;
  }

  async facts(launchedPath: string): Promise<InstallFacts> {
    const [resolvedPath, homeDirectory, platform] = await Promise.all([
      this.#host.realpath(launchedPath),
      this.#host.environment('HOME').then(home => home ?? ''),
      this.#host.platform(),
    ]);
    if (!resolvedPath.startsWith('/nix/store/')) return { launchedPath, resolvedPath, homeDirectory, platform };
    const hops = await symlinkHops(launchedPath, path => this.#host.readLink(path));
    const profile = parseNixProfileList(await this.#host.nixProfile(), [resolvedPath, ...nixPathHops(hops)]);
    return {
      launchedPath,
      resolvedPath,
      homeDirectory,
      platform,
      nixProfileElement: profile.element,
      homeManagerProfile: profile.homeManager,
      viaHomeManagerPath: passesThroughHomeManagerPath(hops),
    };
  }
}
