/**
 * The environment a plugin's `cli` half may read (`CliContext.env`, lead decision 21): the names today's verbs read
 * and nothing else. A name outside this list reads `undefined`, so no credential (`FY_TOKEN`, `FY_SESSION_TOKEN`,
 * `FY_SESSION_BOARD_CAPABILITY`) and no other variable of the caller's shell ever reaches a half. The one other door,
 * `readEnvironment` ({@link declaredEnvironment}), answers only the names a manifest declares and refuses every `FY_*`
 * name and any name that is not a POSIX variable name, whatever the manifest says. Pure: an environment in, the allowed
 * part out.
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
const PLUGIN_ENV_NAMES = [
  'FY_SESSION_ID',
  'FY_SESSION_MODE',
  'FY_HYPERMEDIA',
  'FY_PACK',
  'FY_AGENDA',
  'FY_LEARNING_PASSIVE',
  'PWD',
] as const;

/** A name the shell may be asked for: a POSIX variable name, and never one of Ferretry's own (`FY_TOKEN`, `FY_SESSION_TOKEN`…). */
const READABLE_NAME = /^[A-Z_][A-Z0-9_]*$/u;
const isReadable = (name: string): boolean => READABLE_NAME.test(name) && !name.startsWith('FY_');

/**
 * A family a manifest may declare and a half may ask for: one POSIX prefix, an underscore, then `*` (`ZAI_*`), at
 * least two letters before the underscore, and never one of Ferretry's own (`FY_*`). It names the variables whose name
 * starts with that prefix and nothing else: a bare `*`, a prefix with no underscore, a pattern in the middle and a
 * family under `FY_` all read nothing.
 */
const FAMILY_NAME = /^[A-Z][A-Z0-9]+_(?:[A-Z0-9]+_)*\*$/u;
const isFamily = (name: string): boolean => FAMILY_NAME.test(name) && !name.startsWith('FY_');

/**
 * What `CliContext.readEnvironment(names)` answers: the names asked for that the plugin's manifest DECLARED
 * (`permissions.cliEnvReads`) and the shell has set. A name outside the declaration reads nothing, so a half cannot
 * widen what it sees by asking; nothing declared means nothing read. A declared name is exact, or a family
 * (`ZAI_*`: see {@link FAMILY_NAME}): asking for a declared family answers every set variable of that prefix, under its
 * own name, and asking for one the manifest did not declare answers nothing. WHATEVER A MANIFEST DECLARES, a name that
 * is not a POSIX variable name or that starts with `FY_` reads nothing, and a family never reaches a `FY_` variable:
 * Ferretry's own credentials (`FY_TOKEN`, `FY_SESSION_TOKEN`, `FY_SESSION_BOARD_CAPABILITY`) never reach a half
 * through this door.
 */
export function declaredEnvironment(
  environment: Environment,
  declared: readonly string[] | undefined,
  names: readonly string[],
): CliEnvironment {
  const allowed: Record<string, string> = {};
  for (const name of names) {
    if (declared?.includes(name) !== true) continue;
    if (isFamily(name)) {
      const prefix = name.slice(0, -1);
      for (const [variable, value] of Object.entries(environment)) {
        if (variable.startsWith(prefix) && isReadable(variable) && value !== undefined) allowed[variable] = value;
      }
      continue;
    }
    const value = environment[name];
    if (isReadable(name) && value !== undefined) allowed[name] = value;
  }
  return Object.freeze(allowed);
}

/** The allowed names that are set, with their values as they are, except `PWD`, which is `cwd` (the real working directory). */
export function pluginEnvironment(environment: Environment, cwd: string): CliEnvironment {
  const allowed: Record<string, string> = {};
  for (const name of PLUGIN_ENV_NAMES) {
    const value = name === 'PWD' ? cwd : environment[name];
    if (value !== undefined) allowed[name] = value;
  }
  return Object.freeze(allowed);
}
