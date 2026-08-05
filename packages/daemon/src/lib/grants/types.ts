import type { CapabilityGrants } from '@ferretry/protocol';

/**
 * The ports the grant subsystem is built from.
 *
 * The four types the AUTHORIZATION BOUNDARY needs — the demand, the presentation, the decision and
 * the guard — deliberately live in `src/lib/api/capability.ts` instead of here, so the dependency
 * runs one way. The boundary declares what it must know to decide a request; this subsystem
 * implements it. Nothing in `src/lib/api` imports this directory.
 */

/**
 * The grants a daemon is enforcing right now, or NOTHING when that could not be established.
 *
 * `undefined` is a first-class state rather than an error swallowed somewhere. A daemon whose grant
 * document became unreadable has not reverted to "everything allowed" — it has lost the answer, and
 * every governed capability reads as denied until it is recovered. Damaged state is not empty state.
 */
export type EnforcedGrants = CapabilityGrants | undefined;

/**
 * How the operator's password is checked, without this layer ever holding one.
 *
 * USE, NEVER READ — the same shape the secret store is built on. There is no getter, and adding one
 * would delete the property that makes the rest of this safe: nothing above this port can return,
 * log or render a password, because nothing above it is ever given one to return.
 */
export interface OperatorPasswordPort {
  /** Whether a verifier exists at all. Never how long it is, never any part of it. */
  isSet(): Promise<boolean>;
  /** Replaces the verifier. The plaintext is consumed here and never retained. */
  set(password: string): Promise<void>;
  /** Removes the verifier, which denies every `configure` demand thereafter. */
  clear(): Promise<void>;
  /** Whether this candidate matches the stored verifier. `false` when none is stored. */
  verify(password: string): Promise<boolean>;
}

/** Where the operator's decision is recorded, so a change outlives the daemon that made it. */
export interface GrantDocumentPort {
  read(): Promise<CapabilityGrants>;
  write(grants: CapabilityGrants): Promise<void>;
}

/** One recorded change to the grants, so a decision is visible after the fact. */
export interface GrantAuditEntry {
  /** The resolved actor — `admin-cli`, `admin-ui`, `device:<id>` — never a token. */
  readonly actor: string;
  /** Each axis that moved, as `capability.axis=on|off`. Empty when a patch changed nothing. */
  readonly changes: readonly string[];
  readonly at: string;
}

/**
 * Where a grant change is written down.
 *
 * A PORT rather than a direct journal call, because "who changed what and when" must be provable in
 * the unit tier without a daemon, and because an audit that silently failed would leave exactly the
 * implicit permission state this feature exists to remove.
 */
export interface GrantAuditPort {
  record(entry: GrantAuditEntry): Promise<void>;
}

/** Opaque unlock identifiers, minted with real entropy by an adapter. */
export interface UnlockTokenFactory {
  mint(): string;
}

/** The one clock the grant layer reads, so expiry and lockout are testable without waiting. */
export interface GrantClock {
  nowMs(): number;
}

/** What a caller is told when an unlock is refused, so a UI can count down rather than guess. */
export interface UnlockRefusal {
  readonly reason: 'rate-limited' | 'wrong-password' | 'no-password';
  readonly attemptsRemaining: number;
  readonly lockedUntilMs?: number;
}

export type UnlockOutcome =
  | { readonly kind: 'unlocked'; readonly token: string; readonly expiresAtMs: number }
  | { readonly kind: 'refused'; readonly refusal: UnlockRefusal };
