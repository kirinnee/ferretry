/**
 * Which credential this invocation presents, decided before anything is read or asked (S52, S53, S54, S58, S60).
 *
 * Copied from today's `credential.ts` with the older halves removed: the daemon always takes a ferret's bearer, so
 * there is no feature probe, no fallback to the admin token after a refusal, and an unprefixed pane value is not a
 * credential at all.
 */

/** Every ferret session credential is minted with this prefix. */
export const SESSION_BEARER_PREFIX = 'fys_';

/**
 * Where a ferret's pane carries its own credential: the documented name first. The second name stays because
 * Codex's `shell_environment_policy` strips every variable whose name contains TOKEN, KEY or SECRET from its shell
 * when a config turns the default excludes on, and this name is the one that survives it.
 */
const SESSION_TOKEN_VARIABLES = ['FY_SESSION_TOKEN', 'FY_SESSION_BOARD_CAPABILITY'] as const;

export type Environment = Readonly<Record<string, string | undefined>>;

/** The `fys_` credential this process was started with, if any. A blank or unprefixed value is absent. */
export function paneCredential(environment: Environment): string | undefined {
  for (const name of SESSION_TOKEN_VARIABLES) {
    const value = environment[name]?.trim() ?? '';
    if (value.startsWith(SESSION_BEARER_PREFIX)) return value;
  }
  return undefined;
}

/** The ferret this process runs inside (`FY_SESSION_ID`); blank is absent. */
export function ownFerretId(environment: Environment): string | undefined {
  const value = environment.FY_SESSION_ID?.trim() ?? '';
  return value === '' ? undefined : value;
}

/** Whether this process runs inside a ferret's pane: it has an id or a credential of its own. */
export function inPane(environment: Environment): boolean {
  return ownFerretId(environment) !== undefined || paneCredential(environment) !== undefined;
}

/**
 * 1. `explicit`: `FY_TOKEN`, the owner's scripts and a remote daemon.
 * 2. `ferret`: a `fys_` credential in the environment. Decided from the credential alone, never from
 *    `FY_SESSION_ID`: the admin token file is not opened (S53), and every refusal the daemon gives is the answer (S54).
 * 3. `admin`: a person's own shell, or `--as-owner` set the ferret's credential aside (S58).
 */
export type CredentialPlan =
  | { readonly kind: 'explicit'; readonly token: string }
  | { readonly kind: 'ferret'; readonly bearer: string }
  | { readonly kind: 'admin'; readonly why: 'person' | 'as-owner' };

export function credentialPlan(environment: Environment, options: { readonly asOwner: boolean }): CredentialPlan {
  const explicit = environment.FY_TOKEN?.trim() ?? '';
  if (explicit !== '') return { kind: 'explicit', token: explicit };
  const bearer = paneCredential(environment);
  if (options.asOwner) return { kind: 'admin', why: bearer === undefined ? 'person' : 'as-owner' };
  if (bearer !== undefined) return { kind: 'ferret', bearer };
  return { kind: 'admin', why: 'person' };
}

/**
 * Said on stderr when `--as-owner` sets the ferret's own credential aside: the daemon cannot tell the result from
 * the owner's shell, so the command's own output is the one place the act shows.
 */
export const AS_OWNER_NOTE = '--as-owner: acting with the host admin token, not this ferret’s credential';

/** What `fy doctor` says in a pane (S60): `FY_TOKEN` silently puts that ferret on the admin token. */
export function paneCredentialWarnings(environment: Environment): readonly string[] {
  if (!inPane(environment)) return [];
  if ((environment.FY_TOKEN?.trim() ?? '') === '') return [];
  return [
    'FY_TOKEN is set in this ferret’s environment, so its fy and tools present that token instead of the ferret’s own credential; unset it (a shell rc that exports it reaches every ferret)',
  ];
}

/** Said, whatever the verb, when a person-only call is made from a ferret's pane (S59, S61). `--as-owner` does not lift it. */
export const PERSON_ONLY_REFUSAL = "this is the owner's command; a ferret's pane can't run it";
