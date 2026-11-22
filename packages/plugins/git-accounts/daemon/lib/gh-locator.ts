/**
 * Which `gh` B9 runs with an account's token (r9 B10 SEC): the REAL one, never a file inside the state home.
 *
 * The daemon's own `PATH` can carry Ferretry's `gh` shim folder (a `fy daemon start|restart|update` run from a ferret pane
 * wrote the caller's `PATH` into the unit), and a ferret can rewrite that shim. A bare `gh` lookup would then run the
 * ferret's file WITH the token in its environment. So the lookup here (a) drops every `PATH` folder that is in the state
 * home, (b) asks the kernel to resolve `gh` in what is left, and (c) refuses an answer that still lies in the state home
 * (the kernel falls back to the whole `PATH` when nothing was found in the folders given). The answer is an absolute path.
 */
import { ApiError } from '@ferretry/kernel/contract';
import { GIT_ACCOUNT_CODES } from '../../contract/index.ts';

export interface GhLocatorPorts {
  /** The daemon's own `PATH` (`undefined`: it has none). */
  readonly daemonPath: () => string | undefined;
  /** `kernel.paths.which`: the folders given first, then the daemon's `PATH`. */
  readonly which: (name: string, options: { readonly directories: readonly string[] }) => Promise<string | undefined>;
  /** `kernel.paths.stateHomeHolding`: the state home a path is in, or `undefined`. Throws when the fence cannot be built. */
  readonly stateHomeHolding: (absolutePath: string) => Promise<string | undefined>;
}

const NOT_FOUND = "Ferretry's gh cannot run: no gh program was found outside Ferretry's own folders. Install gh.";
const UNSAFE =
  "Ferretry's gh cannot run: the gh found on this machine's PATH is inside Ferretry's own folders, so it was not trusted with a sign-in.";
const UNCHECKED = "Ferretry's gh cannot run: Ferretry could not check where the gh program is.";

const refuse = (message: string): ApiError => new ApiError(403, message, GIT_ACCOUNT_CODES.invalidRequest);

/** What a `gh` that gets a token is started with: the program, and the `PATH` its own children (`git`, a pager) search. */
export interface GhLaunch {
  /** The absolute path of the `gh` to run. */
  readonly program: string;
  /** The `PATH` of that child: the folders searched, with every state-home folder (the shim folder included) left out. */
  readonly path: string;
}

/** The `gh` to run and the `PATH` to run it with, or a refusal (a 403 `invalid_request` `ApiError`) saying why there is none. */
export function ghLocator(ports: GhLocatorPorts): () => Promise<GhLaunch> {
  return async () => {
    try {
      const folders: string[] = [];
      for (const folder of (ports.daemonPath() ?? '').split(':')) {
        if (!folder.startsWith('/') || folders.includes(folder)) continue;
        if ((await ports.stateHomeHolding(folder)) === undefined) folders.push(folder);
      }
      const found = await ports.which('gh', { directories: folders });
      if (found === undefined) throw refuse(NOT_FOUND);
      if ((await ports.stateHomeHolding(found)) !== undefined) throw refuse(UNSAFE);
      // A sealed child inherits the daemon's whole `PATH`, and that can name the shim folder (a pane's `PATH` written into
      // the unit): the child is given the filtered list instead, and the folder `gh` was found in is always on it.
      const home = found.slice(0, found.lastIndexOf('/')) || '/';
      return { program: found, path: (folders.includes(home) ? folders : [...folders, home]).join(':') };
    } catch (error) {
      throw error instanceof ApiError ? error : refuse(UNCHECKED);
    }
  };
}
