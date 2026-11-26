/**
 * B9 resolves outside the state home, then binds gh to a canonical system installation and file identity.
 * Credential-bearing execution rechecks that binding and uses a fixed minimal child PATH.
 */
import { ApiError, isPackageProgramPath, PACKAGE_PROGRAM_PREFIXES, type PathsPort } from '@ferretry/kernel/contract';
import { dirname } from 'node:path';
import { userInfo } from 'node:os';
import { GIT_ACCOUNT_CODES } from '../../contract/index.ts';
import type { ProgramLocatorPorts, TrustedLaunch } from './program-locator.ts';

export type GhLocatorPorts = ProgramLocatorPorts & Pick<PathsPort, 'bindProgram' | 'home'>;
/** What a `gh` that gets a token is started with: the program, and the `PATH` its own children (`git`, a pager) search. */
export type GhLaunch = TrustedLaunch & { verify(): Promise<boolean> };

/** The `gh` to run and the `PATH` to run it with, or a refusal (a 403 `invalid_request` `ApiError`) saying why there is none. */
export function ghLocator(ports: GhLocatorPorts): () => Promise<GhLaunch> {
  const locate = async (name: 'gh' | 'git') => {
    try {
      // Fixed package/profile roots only. PATH must never select the set of trusted Nix-store packages.
      const profiles = [
        `${ports.home()}/.nix-profile/bin`,
        `/etc/profiles/per-user/${userInfo().username}/bin`,
        '/nix/var/nix/profiles/default/bin',
        '/run/current-system/sw/bin',
      ];
      const directories = [...PACKAGE_PROGRAM_PREFIXES.map(prefix => `${prefix}/bin`), ...profiles, '/usr/bin', '/bin'];
      const found = await ports.which(name, { directories });
      if (found === undefined)
        throw new ApiError(
          403,
          `Ferretry's ${name} cannot run: no ${name} program was found outside Ferretry's own folders in a trusted installation. Install ${name}.`,
          GIT_ACCOUNT_CODES.invalidRequest,
        );
      if ((await ports.stateHomeHolding(found)) !== undefined)
        throw new ApiError(
          403,
          `Ferretry's ${name} cannot run: the program is inside Ferretry's own folders.`,
          GIT_ACCOUNT_CODES.invalidRequest,
        );
      const pinned = directories.includes(dirname(found)) ? await ports.bindProgram(found) : undefined;
      if (
        pinned === undefined ||
        (profiles.includes(dirname(found)) && !pinned.program.startsWith('/nix/store/')) ||
        (!isPackageProgramPath(pinned.program) && !['/usr/bin', '/bin'].includes(dirname(pinned.program))) ||
        (await ports.stateHomeHolding(pinned.program)) !== undefined
      )
        throw new ApiError(
          403,
          `GitHub client unavailable: ${name} is not in a trusted installation.`,
          GIT_ACCOUNT_CODES.invalidRequest,
        );
      return pinned;
    } catch (error) {
      throw error instanceof ApiError
        ? error
        : new ApiError(403, `Ferretry could not check where the ${name} program is.`, GIT_ACCOUNT_CODES.invalidRequest);
    }
  };
  return async () => {
    const pinned = await locate('gh');
    const git = await locate('git');
    // Bound git must win over any git beside gh. Never inherit pane/profile/PATH entries.
    const path = [...new Set([dirname(git.program), dirname(pinned.program), '/usr/bin', '/bin'])].join(':');
    return { program: pinned.program, path, verify: async () => (await pinned.verify()) && (await git.verify()) };
  };
}
