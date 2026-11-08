/** The pane's hypermedia variable (read by `fy mcp serve`): `1` told, `0` not told. */
const HYPERMEDIA_ENV = 'FY_HYPERMEDIA';

/**
 * `launch.parts`: what a launch says about hypermedia. Only a switch the owner SET is said; a ferret with none keeps
 * the mode default Ferrets already wrote, so the machine never overrides a default it has no opinion on.
 */
export function hypermediaLaunchEnvironment(recorded: boolean | undefined): Readonly<Record<string, string>> {
  return recorded === undefined ? {} : { [HYPERMEDIA_ENV]: recorded ? '1' : '0' };
}
