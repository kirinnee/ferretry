/**
 * B9 resolves outside the state home, then binds gh to a canonical system installation and file identity.
 * Credential-bearing execution rechecks that binding and uses a fixed minimal child PATH.
 */
import { ApiError, type PathsPort } from '@ferretry/kernel/contract';
import { GIT_ACCOUNT_CODES } from '../../contract/index.ts';
import { type ProgramLocatorPorts, type TrustedLaunch, programLocator } from './program-locator.ts';

export type GhLocatorPorts = ProgramLocatorPorts & Pick<PathsPort, 'bindProgram'>;
/** What a `gh` that gets a token is started with: the program, and the `PATH` its own children (`git`, a pager) search. */
export type GhLaunch = TrustedLaunch & { verify(): Promise<boolean> };

/** Fixed system folders only: descendants never search a pane's PATH or a user install directory. */
const GH_CHILD_PATH = '/usr/bin:/bin';

/** The `gh` to run and the `PATH` to run it with, or a refusal (a 403 `invalid_request` `ApiError`) saying why there is none. */
export function ghLocator(ports: GhLocatorPorts): () => Promise<GhLaunch> {
  const locate = programLocator({ name: 'gh', trustedWith: 'a sign-in' }, ports);
  return async () => {
    const found = await locate();
    const pinned = await ports.bindProgram(found.program).catch(() => undefined);
    if (pinned === undefined)
      throw new ApiError(
        403,
        'GitHub client unavailable: gh is not in a trusted installation.',
        GIT_ACCOUNT_CODES.invalidRequest,
      );
    return { program: pinned.program, path: GH_CHILD_PATH, verify: () => pinned.verify() };
  };
}
