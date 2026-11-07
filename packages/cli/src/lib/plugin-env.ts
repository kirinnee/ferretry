/**
 * The environment a plugin's `cli` half may read (`CliContext.env`, lead decision 21): the names today's verbs read
 * and nothing else. A name outside this list reads `undefined`, so no credential (`FY_TOKEN`, `FY_SESSION_TOKEN`,
 * `FY_SESSION_BOARD_CAPABILITY`) and no other variable of the caller's shell ever reaches a half. Pure: an
 * environment in, the allowed part out.
 */
import type { CliEnvironment } from '@ferretry/kernel/manifest';
import type { Environment } from './credential.ts';

/**
 * - `FY_SESSION_ID`: the ferret this process runs inside (`fy pack`, `fy card --mine`, `fy instructions`).
 * - `FY_SESSION_MODE`, `FY_HYPERMEDIA`, `FY_PACK`, `FY_AGENDA`, `FY_LEARNING_PASSIVE`: the launch switches
 *   `fy instructions` reports, the same variables the runtime wrapper composed the appended prompt from.
 * - `PWD`: where `fy` was run, for a folder typed relative to it (`fy pack <folder>`). It is NOT copied from the
 *   inherited variable (a parent that spawns `fy` with its own `cwd` leaves `PWD` stale): it is the CLI's real
 *   working directory, handed in by the caller.
 */
export const PLUGIN_ENV_NAMES = [
  'FY_SESSION_ID',
  'FY_SESSION_MODE',
  'FY_HYPERMEDIA',
  'FY_PACK',
  'FY_AGENDA',
  'FY_LEARNING_PASSIVE',
  'PWD',
] as const;

/** The allowed names that are set, with their values as they are, except `PWD`, which is `cwd` (the real working directory). */
export function pluginEnvironment(environment: Environment, cwd: string): CliEnvironment {
  const allowed: Record<string, string> = {};
  for (const name of PLUGIN_ENV_NAMES) {
    const value = name === 'PWD' ? cwd : environment[name];
    if (value !== undefined) allowed[name] = value;
  }
  return Object.freeze(allowed);
}
