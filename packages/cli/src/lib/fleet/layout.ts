import type { FleetLayout } from '@ferretry/fleet';

/** Inputs the composition root reads once and hands in; nothing here discovers anything. */
export interface FleetLayoutInputs {
  /** `FY_HOME`, or blank when it is not set. */
  readonly stateHome: string | undefined;
  readonly userHome: string;
  /** The product name, so the default state home is single-sourced rather than spelled here. */
  readonly product: string;
}

/** Join without pulling `node:path` into the domain layer; every input is already absolute. */
function join(directory: string, name: string): string {
  return directory.endsWith('/') ? `${directory}${name}` : `${directory}/${name}`;
}

/**
 * Where the fleet's directories live.
 *
 * A pure function of the environment, so the whole layout is a value a test asserts on. It is also
 * the only place the state-home default is decided — `apply` and `usage` must agree on where the
 * manifest is, and kteam's two callers each computed it separately and disagreed on one host.
 */
export function resolveFleetLayout(inputs: FleetLayoutInputs): FleetLayout {
  const home = inputs.userHome.trim();
  if (home === '') throw new Error('cannot resolve the fleet layout without a home directory');
  const configured = inputs.stateHome?.trim() ?? '';
  const stateHome = configured === '' ? join(home, `.${inputs.product}`) : configured;
  const fleetDirectory = join(stateHome, 'fleet');
  return {
    stateHome,
    userHome: home,
    fleetDirectory,
    binDirectory: join(fleetDirectory, 'bin'),
    homesDirectory: join(fleetDirectory, 'homes'),
    assetsDirectory: join(fleetDirectory, 'assets'),
    manifestPath: join(fleetDirectory, 'manifest.json'),
    defaultHomeDirectories: { claude: join(home, '.claude'), codex: join(home, '.codex') },
  };
}

/** Where `fy fleet apply` reads its configuration when `--config` did not say. */
export function defaultConfigPath(layout: FleetLayout): string {
  return join(layout.fleetDirectory, 'config.yaml');
}
