/**
 * Which program runs with a secret (r9 B10 SEC, widened in E6): the REAL one, never a file inside the state home.
 *
 * The daemon's own `PATH` can carry Ferretry's shim folder (a `fy daemon start|restart|update` run from a ferret pane
 * wrote the caller's `PATH` into the unit), and a ferret can rewrite a shim. A bare name lookup would then run the
 * ferret's file WITH the secret (`gh`'s token in its environment, `ssh-add -`'s private key on its stdin). So the lookup
 * here (a) drops every `PATH` folder that is in the state home, (b) asks the kernel to resolve the name in what is left,
 * and (c) refuses an answer that still lies in the state home (the kernel falls back to the whole `PATH` when nothing was
 * found in the folders given). The answer is an absolute path, and a program that is not found is a refusal: it never
 * falls back to a bare name.
 */
import { ApiError } from '@ferretry/kernel/contract';
import { GIT_ACCOUNT_CODES } from '../../contract/index.ts';

export interface ProgramLocatorPorts {
  /** The daemon's own `PATH` (`undefined`: it has none). */
  readonly daemonPath: () => string | undefined;
  /** `kernel.paths.which`: the folders given first, then the daemon's `PATH`. */
  readonly which: (name: string, options: { readonly directories: readonly string[] }) => Promise<string | undefined>;
  /** `kernel.paths.stateHomeHolding`: the state home a path is in, or `undefined`. Throws when the fence cannot be built. */
  readonly stateHomeHolding: (absolutePath: string) => Promise<string | undefined>;
}

/** What a program that gets a secret is started with: the program, and the `PATH` its own children search. */
export interface TrustedLaunch {
  /** The absolute path of the program to run. */
  readonly program: string;
  /** The `PATH` of that child: the folders searched, with every state-home folder (the shim folder included) left out. */
  readonly path: string;
}

/** What the program is trusted with, in the words of a refusal (`a sign-in`, `an account key`). */
export interface TrustedProgram {
  readonly name: string;
  readonly trustedWith: string;
}

const refuse = (message: string): ApiError => new ApiError(403, message, GIT_ACCOUNT_CODES.invalidRequest);

/** The program to run and the `PATH` to run it with, or a refusal (a 403 `invalid_request` `ApiError`) saying why there is none. */
export function programLocator(what: TrustedProgram, ports: ProgramLocatorPorts): () => Promise<TrustedLaunch> {
  const { name } = what;
  const notFound = `Ferretry's ${name} cannot run: no ${name} program was found outside Ferretry's own folders. Install ${name}.`;
  const unsafe = `Ferretry's ${name} cannot run: the ${name} found on this machine's PATH is inside Ferretry's own folders, so it was not trusted with ${what.trustedWith}.`;
  const unchecked = `Ferretry's ${name} cannot run: Ferretry could not check where the ${name} program is.`;
  return async () => {
    try {
      const folders: string[] = [];
      for (const folder of (ports.daemonPath() ?? '').split(':')) {
        if (!folder.startsWith('/') || folders.includes(folder)) continue;
        if ((await ports.stateHomeHolding(folder)) === undefined) folders.push(folder);
      }
      const found = await ports.which(name, { directories: folders });
      if (found === undefined || !found.startsWith('/')) throw refuse(notFound);
      if ((await ports.stateHomeHolding(found)) !== undefined) throw refuse(unsafe);
      // A sealed child inherits the daemon's whole `PATH`, and that can name the shim folder (a pane's `PATH` written into
      // the unit): the child is given the filtered list instead, and the folder the program was found in is always on it.
      const home = found.slice(0, found.lastIndexOf('/')) || '/';
      return { program: found, path: (folders.includes(home) ? folders : [...folders, home]).join(':') };
    } catch (error) {
      throw error instanceof ApiError ? error : refuse(unchecked);
    }
  };
}
