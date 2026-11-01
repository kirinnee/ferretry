import { DAEMON_FEATURES, hasFeature } from '@ferretry/protocol';

/**
 * The prefix every ferret session credential is minted with since RF-1. Duplicated from the daemon's
 * `authentication.ts` on purpose: the CLI may import `@ferretry/protocol` and nothing else from the
 * monorepo. A value without it is a pane's credential from before the prefix.
 */
const SESSION_BEARER_PREFIX = 'fys_';

/**
 * Where a ferret's pane carries its own credential: the documented name first, then the older one. The
 * daemon writes both with one value (`session/lifecycle/policy.ts` `sessionPaneEnvironment`), so the order
 * only matters to a hand-built environment, and the documented name wins there.
 */
const SESSION_TOKEN_VARIABLES = ['FY_SESSION_TOKEN', 'FY_SESSION_BOARD_CAPABILITY'] as const;

/**
 * The ferret session credential this process was started with, if any.
 *
 * - `bearer`: a `fys_` value, which a daemon that offers `session.credential.1` accepts as
 *   `Authorization: Bearer` on every route a ferret may call.
 * - `legacy`: an unprefixed value from a pane started before RF-1. No daemon resolves it as a bearer,
 *   so it is NEVER sent as one: it goes only on the agent routes' `x-fy-session-capability` header,
 *   exactly as before, until that pane restarts and is handed a prefixed one.
 */
export type PaneCredential =
  | { readonly kind: 'none' }
  | { readonly kind: 'bearer'; readonly value: string }
  | { readonly kind: 'legacy'; readonly value: string };

/** Reads {@link SESSION_TOKEN_VARIABLES}; a blank value is absent, never an empty credential. */
export function paneCredential(environment: Readonly<Record<string, string | undefined>>): PaneCredential {
  for (const name of SESSION_TOKEN_VARIABLES) {
    const value = environment[name]?.trim() ?? '';
    if (value === '') continue;
    return value.startsWith(SESSION_BEARER_PREFIX) ? { kind: 'bearer', value } : { kind: 'legacy', value };
  }
  return { kind: 'none' };
}

/** The value of {@link paneCredential} in either form, for the agent routes' own header. */
export function paneCredentialValue(environment: Readonly<Record<string, string | undefined>>): string | undefined {
  const credential = paneCredential(environment);
  return credential.kind === 'none' ? undefined : credential.value;
}

/**
 * Which credential this invocation presents, before anything is read or asked.
 *
 * 1. `explicit` — `FY_TOKEN`: the owner's scripts and a remote daemon. Unchanged.
 * 2. `session` — this process runs with a `fys_` ferret credential. It is offered to the daemon, and the
 *    host's `api-token` is NOT OPENED unless that daemon says it does not take the credential at all
 *    ({@link presentsSessionBearer}). Decided from the credential alone, never from `FY_SESSION_ID`: a
 *    ferret that runs `fy` without its session id must not fall to the admin token while its pane holds
 *    a credential of its own (the actor would read as the owner).
 * 3. `admin` — today's local `api-token`: a person's own shell, a pane from before the prefix, or
 *    `--as-owner`.
 *
 * `--as-owner` skips step 2. It is for a person who attached to a ferret's pane and wants their own
 * rights there; it works only where `api-token` is readable, so it is no wall against a ferret that does
 * the same (docs/secrets.md § "What a ferret's `fy` presents").
 */
export type CredentialPlan =
  | { readonly kind: 'explicit'; readonly token: string }
  | { readonly kind: 'session'; readonly bearer: string }
  | { readonly kind: 'admin'; readonly why: 'no-session' | 'legacy-session' | 'as-owner' };

export function credentialPlan(
  environment: Readonly<Record<string, string | undefined>>,
  options: { readonly asOwner: boolean },
): CredentialPlan {
  const explicit = environment.FY_TOKEN?.trim() ?? '';
  if (explicit !== '') return { kind: 'explicit', token: explicit };
  if (options.asOwner) return { kind: 'admin', why: 'as-owner' };
  const pane = paneCredential(environment);
  if (pane.kind === 'bearer') return { kind: 'session', bearer: pane.value };
  return { kind: 'admin', why: pane.kind === 'legacy' ? 'legacy-session' : 'no-session' };
}

/** What one `/v1/health` answer says about a daemon, as far as the credential choice is concerned. */
export interface DaemonInstanceFacts {
  /** The process that answered; a different pid at the same URL is a different daemon. */
  readonly pid: number | undefined;
  readonly features: readonly string[];
}

/**
 * Whether a daemon takes the ferret's session bearer. THIS, and never an error code, decides the
 * fallback (plan §9.1): a daemon that offers `session.credential.1` is answered with the bearer only,
 * and every refusal it gives — 401, 403 `owner_only`, 404, 5xx — is reported as its answer.
 */
export function presentsSessionBearer(facts: DaemonInstanceFacts): boolean {
  return hasFeature(facts, DAEMON_FEATURES.sessionCredential);
}

/**
 * After the daemon answered the bearer with `401`: what a fresh `/v1/health` read allows. Only a daemon
 * that NO LONGER offers the credential — it restarted onto a bind where no bearer resolves, or was
 * downgraded — earns the admin token; one that still offers it refused this credential, and that
 * refusal is the answer.
 */
export function mayFallBackAfterRefusal(status: number, fresh: DaemonInstanceFacts): boolean {
  return status === 401 && !presentsSessionBearer(fresh);
}
