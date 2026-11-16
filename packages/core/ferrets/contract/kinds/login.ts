import type { SharedCredential } from '@ferretry/kernel/contract';
import type { InputRequestId } from '@ferretry/core-vault/contract';
import type { Instant, Result } from '@ferretry/std';
import type { HarnessKey, LoginKindKey } from '../ids.ts';

// ─── login (§4.4) ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface LoginField {
  readonly id: string;
  readonly label: string;
  /** A secret field is asked on an input card and lives only in the Vault. */
  readonly secret: boolean;
}

/** How a sign-in proceeds: a browser OAuth page, a device code on a card, or a key typed on an input card. */
export type SignInFlow =
  | { readonly kind: 'browser'; readonly url: string }
  | { readonly kind: 'device-code'; readonly url: string; readonly code: string }
  | { readonly kind: 'input'; readonly request: InputRequestId }
  | { readonly kind: 'done' };

export type LoginStatus =
  | { readonly state: 'signed-in'; readonly refreshDue?: Instant }
  | { readonly state: 'signed-out' | 'expired'; readonly sentence: string };

export interface LoginQuota {
  readonly fiveHourPercent?: number;
  readonly weeklyPercent?: number;
  readonly resetsAt?: Instant;
}

/** The value of `logins:<kind>` (§4.4). Values live only in the Vault; `env` returns `${secret:NAME}` references. */
export interface LoginKind {
  readonly key: LoginKindKey;
  readonly fields: readonly LoginField[];
  /** Which harnesses can spend it. */
  readonly harnesses: readonly HarnessKey[];
  /** Whether this machine holds a login of this name AND of this kind (a name is one kind's, never two). */
  holds(login: string): boolean;
  signIn(login: string): Promise<SignInFlow>;
  status(login: string): Promise<LoginStatus>;
  refresh?(login: string): Promise<LoginStatus>;
  quota?(login: string): Promise<LoginQuota | undefined>;
  /** The environment or config the harness needs, values as `${secret:NAME}` only. */
  env(login: string, harness: HarnessKey): Promise<Readonly<Record<string, string>>>;
  /**
   * What FERRETRY (not the login's file) sets so this harness is signed in on this login: for a Claude sign-in kept in
   * Ferretry's store, the one variable that points Claude at that store. Kept apart from {@link env}, which is only what
   * the login file declares. An error is a sentence for the owner (the login has no usable sign-in) and refuses the
   * start, so no pane starts signed out. A kind with nothing to add leaves it out.
   */
  launchEnvironment?(login: string, harness: HarnessKey): Promise<Result<Readonly<Record<string, string>>, string>>;
  /**
   * For a login whose sign-in is a FILE the harness reads (Codex's `auth.json`): the file shared with that harness, or
   * why it cannot be used. Absent on a kind that has none (an environment login). Never refreshes: a Codex refresh
   * spends a single-use token, and the harness renews its own file in place.
   */
  credential?(login: string, harness: HarnessKey): Promise<LoginCredentialAnswer>;
}

/**
 * What {@link LoginKind.credential} answers. `file` carries the kernel's unforgeable {@link SharedCredential} (never a
 * path or a value); `unavailable` carries one plain sentence naming the login and the remedy, never a path or a token.
 */
export type LoginCredentialAnswer =
  /** Nothing to place: this login arrives as environment, or this kind has no sign-in file. */
  | { readonly kind: 'none' }
  | { readonly kind: 'file'; readonly credential: SharedCredential }
  | { readonly kind: 'unavailable'; readonly sentence: string };
