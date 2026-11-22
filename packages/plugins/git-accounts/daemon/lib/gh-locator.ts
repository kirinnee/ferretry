/**
 * Which `gh` B9 runs with an account's token (r9 B10 SEC): the REAL one, never a file inside the state home.
 *
 * The rule (drop state-home `PATH` folders, resolve in what is left, refuse an answer still in the state home, answer an
 * absolute path and the filtered `PATH` for the child) is `program-locator.ts`, shared with `ssh-agent` and `ssh-add`.
 */
import { type ProgramLocatorPorts, type TrustedLaunch, programLocator } from './program-locator.ts';

export type GhLocatorPorts = ProgramLocatorPorts;
/** What a `gh` that gets a token is started with: the program, and the `PATH` its own children (`git`, a pager) search. */
export type GhLaunch = TrustedLaunch;

/** The `gh` to run and the `PATH` to run it with, or a refusal (a 403 `invalid_request` `ApiError`) saying why there is none. */
export function ghLocator(ports: GhLocatorPorts): () => Promise<GhLaunch> {
  return programLocator({ name: 'gh', trustedWith: 'a sign-in' }, ports);
}
