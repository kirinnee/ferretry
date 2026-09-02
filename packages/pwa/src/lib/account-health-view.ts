/**
 * ACCOUNT HEALTH, IN WORDS. One projection, so every surface says the same thing.
 *
 * The daemon publishes a verdict and a reason CODE. The words are here, once, and
 * both the picker row and the Fleet surface read them — because the two screens
 * showing the same account must not describe it differently, and a second copy
 * table is how that happens.
 *
 * ## The three sentences that must never merge
 *
 *   - `Unknown · Never checked`  — nobody has looked. `lastCheckedAt` is `null`.
 *   - `Unknown · Checked 1m ago` — somebody looked and could not tell.
 *   - `Needs re-login`          — somebody looked and the credential is dead.
 *
 * Each is one collapsed branch away from telling a person their working fleet is
 * broken, or their broken fleet is fine.
 *
 * ## Why `Needs credential` exists beside `Needs re-login`
 *
 * An account authenticated by an environment variable or a token file CANNOT be
 * fixed by signing in: the harness reads that value and never consults its own
 * credential store, so a sign-in button would open a browser, write a store
 * nobody reads, and change nothing. Offering it is worse than offering nothing.
 * {@link accountHealthOffersSignIn} is what a surface asks before drawing one.
 *
 * ## The 403 row
 *
 * `usage_scope_unavailable` is HEALTHY. The token lacks `user:profile`, which is
 * permanent and expected for an inference-scoped token, and it says nothing about
 * whether the account works — only that its quota cannot be read. So the verdict
 * is healthy and the QUOTA is what goes unknown. A quota bar must not be drawn at
 * 0 % for it; `QuotaReadout`'s `showUnknown` is how the rows already avoid that.
 *
 * ## What a surface with ONE line may leave out
 *
 * `quiet` and `detailIsImplied` are offers, not instructions. They exist because
 * the fleet roster spent three of every row's four lines on `Unknown · Never
 * checked · Nothing has checked this account yet.` — the same nothing, three
 * times, on every account — which is what turned a list of accounts into a wall.
 * Neither flag can hide a bad verdict: `quiet` is true only where nobody has
 * looked, and `detailIsImplied` only where the reason repeats its own headline.
 * Each surface decides for itself whether to take the offer.
 *
 * Pure. No clock of its own: `now` is passed in, so a relative label is
 * deterministic in a test and can tick in the client without anything claiming a
 * fresh check happened.
 */

import type {
  PickerAccountHealth,
  PickerHealthReason,
  PickerHealthVerdict,
  PickerRefreshRotation,
  PickerSeedProvenance,
  PickerSeedProvenanceState,
} from './account-picker-catalog.ts';

/** The tone a row paints itself with. Deliberately four, matching the four verdicts. */
export type AccountHealthTone = 'ok' | 'bad' | 'warn' | 'muted';

export interface AccountHealthView {
  /** The headline: `Healthy`, `Needs re-login`, `Needs credential`, `Unknown`. */
  readonly label: string;
  /** The instant clause beside it: `Checked 4m ago`, `Never checked`, `Confirmed 8m ago`. */
  readonly checked: string;
  /** The reason, in words. Always present: a bare verdict is not actionable. */
  readonly detail: string;
  /** A second clause when the newest attempt failed but the conclusion still stands. */
  readonly secondary?: string;
  readonly tone: AccountHealthTone;
  /** Whether a sign-in control can possibly help. See the module note. */
  readonly offersSignIn: boolean;
  /**
   * Nothing has been established about this account at all, so a surface with one line to spend may
   * spend it on something else.
   *
   * NOT a fifth verdict and not a licence to hide a bad one. It is true for exactly one state —
   * nobody has looked — and that state's three sentences say the same nothing three times over.
   * A surface that prints them is spending its whole row telling somebody that nothing happened,
   * which is what the owner was looking at when they said the roster was the page. Whether to take
   * the offer is the surface's own call: a chooser where "nobody checked this" changes which account
   * you pick should still say so.
   */
  readonly quiet: boolean;
  /**
   * The reason says nothing the label has not already said, so a one-line surface may drop it.
   *
   * Per REASON rather than per verdict, because the pair that must survive is `Healthy` beside
   * "quota is not measurable": those are two facts and dropping the second reads an unmeasurable
   * account as a broken one. Only the reasons that RESTATE their own headline are implied.
   */
  readonly detailIsImplied: boolean;
  /**
   * Where this account's credential came from, when a first run recorded it. Absent means silence.
   *
   * NOT part of the verdict and never coloured like one. It changes no decision and contradicts
   * nothing above it — see {@link seedProvenanceNote}.
   */
  readonly seedProvenance?: SeedProvenanceNote;
}

/** One account's provenance, as the two clauses a row prints and the tone it prints them in. */
export interface SeedProvenanceNote {
  /** What is known: still the copy, its own now, or could not be told. */
  readonly headline: string;
  /**
   * What renewing it may cost the install it came from, when there is still something to cost.
   *
   * Absent for a home that has since rotated, because the risk has passed and a warning about a
   * consequence that can no longer happen is noise on the one row that should be quiet.
   */
  readonly consequence?: string;
  /** `warn` where the donor may still be at risk, `muted` where it is not. Never `bad`: this is not a fault. */
  readonly tone: Extract<AccountHealthTone, 'warn' | 'muted'>;
}

/** Whole days, absolute and in UTC, because a seed may be months old and "94d ago" is not a date. */
function seedDateLabel(instant: number): string {
  const date = new Date(instant);
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][
    date.getUTCMonth()
  ];
  return `${String(date.getUTCDate())} ${month ?? '?'} ${String(date.getUTCFullYear())}`;
}

/**
 * WHAT RENEWING A SEEDED COPY MAY COST THE INSTALL IT WAS TAKEN FROM.
 *
 * ## THE CONDITIONAL IS NOT HEDGING AND MUST NOT BE COPY-EDITED AWAY
 *
 * Nothing in this product proves that Claude's refresh tokens rotate. Single-use rotation is
 * established for Codex only. So the `unproven` sentence says "if … may", and flattening it into
 * "renewing this will sign that install out" would be asserting a measurement nobody has taken —
 * about somebody's own login, on the screen they are reading to decide whether to press Renew.
 *
 * Which sentence applies is NOT decided here. `rotation` arrives on the row from the daemon, which
 * owns that claim once for this browser and for the terminal, so the two cannot drift apart.
 */
const ROTATION_CONSEQUENCE: Readonly<Record<PickerRefreshRotation, (harness: string) => string>> = {
  single_use: harness =>
    `${harness} refresh tokens are single-use, so renewing this — or running an agent on it — signs that install out.`,
  unproven: harness =>
    `If ${harness} rotates refresh tokens, renewing this — or running an agent on it — may sign that install out.`,
};

/**
 * The headline per state, exhaustive so a state added tomorrow is a compile error rather than a row
 * that silently stops saying anything.
 */
const PROVENANCE_HEADLINE: Readonly<Record<PickerSeedProvenanceState, (harness: string, where: string) => string>> = {
  seeded_copy: (harness, where) => `Still the copy taken from this host’s own ${harness} install ${where}.`,
  own_login: (harness, where) =>
    `Its own login. It was seeded from this host’s own ${harness} install ${where} and has been replaced since.`,
  undetermined: (harness, where) =>
    `This account’s credential could not be read, so this cannot tell whether it is still the copy taken from this host’s own ${harness} install ${where}. It is shown as if it were.`,
};

/** Whether the donor may still be spent by acting on this account. `own_login` cannot be. */
const PROVENANCE_AT_RISK: Readonly<Record<PickerSeedProvenanceState, boolean>> = {
  seeded_copy: true,
  undetermined: true,
  own_login: false,
};

/**
 * One account's provenance in words, or nothing at all.
 *
 * `undefined` in means NO RECORD, and silence is the only honest rendering of that: a home seeded
 * before the daemon learned to record this can never get a record, so those are exactly the accounts
 * nothing can be said about. Rendering the absence as "its own login" would clear them falsely.
 *
 * `harness` is the account's own kind as a person writes it. The caller supplies it because the
 * health row publishes `kind` as an open string — a daemon that grows a third harness stays
 * conformant, and a closed lookup here would put `undefined` in the middle of a sentence about
 * somebody's credential.
 */
export function seedProvenanceNote(
  provenance: PickerSeedProvenance | undefined,
  harness: string,
): SeedProvenanceNote | undefined {
  if (provenance === undefined) return undefined;
  const where = `(${provenance.donorHome}) on ${seedDateLabel(provenance.seededAt)}`;
  const atRisk = PROVENANCE_AT_RISK[provenance.state];
  return {
    headline: PROVENANCE_HEADLINE[provenance.state](harness, where),
    ...(atRisk ? { consequence: ROTATION_CONSEQUENCE[provenance.rotation](harness) } : {}),
    tone: atRisk ? 'warn' : 'muted',
  };
}

const VERDICT_LABEL: Readonly<Record<PickerHealthVerdict, string>> = {
  healthy: 'Healthy',
  needs_relogin: 'Needs re-login',
  needs_credentials: 'Needs credential',
  unknown: 'Unknown',
};

const VERDICT_TONE: Readonly<Record<PickerHealthVerdict, AccountHealthTone>> = {
  healthy: 'ok',
  needs_relogin: 'bad',
  needs_credentials: 'bad',
  unknown: 'warn',
};

/**
 * Why, in one clause each.
 *
 * Every reason has words. A reason with no sentence would render as a bare
 * verdict, and "Unknown" with nothing after it is the state this whole feature
 * exists to stop showing people.
 */
const REASON_DETAIL: Readonly<Record<PickerHealthReason, string>> = {
  provider_accepted: 'The provider accepted this account’s credential.',
  usage_scope_unavailable: 'Accepted, but this token cannot read usage, so quota is not measurable.',
  oauth_credential_missing: 'There is no credential in this account’s home.',
  oauth_access_expired: 'The access token expired and there is nothing to renew it with.',
  oauth_token_rejected: 'The provider rejected this token.',
  static_credential_missing: 'The credential this account is configured to use is not there.',
  static_credential_rejected: 'The provider rejected the credential this account is configured to use.',
  never_checked: 'Nothing has checked this account yet.',
  credential_unreadable: 'The credential could not be read, so nothing is known either way.',
  oauth_refreshable: 'Signed in, but this copy needs refreshing.',
  oauth_rejection_unconfirmed:
    'The OAuth check was refused, but Ferretry could not tell whether the provider rejected this login or this client. This result does not mean you need to sign in again.',
  codex_liveness_unproven: 'Codex has no free way to prove a sign-in, so this is not a verdict about it.',
  check_timeout: 'The last check timed out.',
  provider_unavailable: 'The provider could not be reached.',
  provider_not_asked: 'Signed in on this host. The provider has not confirmed it.',
  credential_changed_during_check: 'The credential changed while the check was running, so its result was discarded.',
  account_unavailable: 'This account is published as unavailable, so nothing was checked.',
  stale: 'The last result is too old to trust.',
};

/**
 * Which reasons only restate their own verdict.
 *
 * Annotated over every reason rather than derived from the words, so a reason added tomorrow is a
 * compile error here instead of a sentence that silently stops being printed. Exactly two qualify:
 * "the provider accepted this credential" IS `Healthy`, and "nothing has checked this account yet"
 * IS `Unknown · Never checked`. Everything else — a 403 that cannot read usage, a Codex that has no
 * free proof, a check that timed out — carries a fact the headline does not.
 */
const REASON_IS_IMPLIED: Readonly<Record<PickerHealthReason, boolean>> = {
  provider_accepted: true,
  never_checked: true,
  usage_scope_unavailable: false,
  oauth_credential_missing: false,
  oauth_access_expired: false,
  oauth_token_rejected: false,
  static_credential_missing: false,
  static_credential_rejected: false,
  credential_unreadable: false,
  oauth_refreshable: false,
  oauth_rejection_unconfirmed: false,
  codex_liveness_unproven: false,
  check_timeout: false,
  provider_unavailable: false,
  provider_not_asked: false,
  credential_changed_during_check: false,
  account_unavailable: false,
  stale: false,
};

/** Whole units, coarsest that fits. A reader wants "4m ago", never a millisecond count. */
export function relativeInstantLabel(instant: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - instant) / 1_000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/** The exact instant, for the accessible name and the title. A relative label alone is not a time. */
export function absoluteInstantLabel(instant: number): string {
  return new Date(instant).toISOString();
}

/** Whether a sign-in control could possibly fix this. See the module note on `Needs credential`. */
export function accountHealthOffersSignIn(health: PickerAccountHealth): boolean {
  return health.verdict === 'needs_relogin';
}

/**
 * One account's health as the words a row prints.
 *
 * The `checked` clause is chosen from what is actually known rather than from the
 * verdict, and the three cases are the three sentences in the module note:
 *
 *   - never checked      -> `Never checked`, and no time is invented
 *   - conclusion is live -> `Confirmed 8m ago`, dated from the EVIDENCE, because
 *     that is when the claim was last true rather than when a request last ran
 *   - no conclusion      -> `Checked 1m ago`, dated from the check
 *
 * `secondary` appears only when both are true at once: there is a conclusion, and
 * the newest attempt to re-prove it failed. Hiding that is how a fleet reads
 * healthy while every provider call is failing.
 */
/**
 * The harness as a person writes it, tolerating one this build has never heard of.
 *
 * `kind` is an open string on the wire so a daemon that grows a third harness stays conformant. The
 * raw kind is at least true; `undefined` in the middle of a sentence about somebody's credential is
 * not.
 */
function harnessLabel(kind: string): string {
  return kind === 'claude' ? 'Claude' : kind === 'codex' ? 'Codex' : kind;
}

export function accountHealthView(health: PickerAccountHealth, now: number): AccountHealthView {
  const provenance = seedProvenanceNote(health.seedProvenance, harnessLabel(health.kind));
  const detail =
    // A stale row's own reason says only "too old"; the reader also wants to know WHAT went stale,
    // because a bare Unknown there looks exactly like an account nobody ever checked.
    health.staleVerdict === undefined
      ? REASON_DETAIL[health.reason]
      : `${REASON_DETAIL.stale} It last read ${VERDICT_LABEL[health.staleVerdict].toLowerCase()}.`;
  const secondary =
    health.lastCheckInconclusive && health.verdictAt !== null && health.lastCheckedAt !== null
      ? `The check ${relativeInstantLabel(health.lastCheckedAt, now)} was inconclusive.`
      : undefined;
  return {
    label: VERDICT_LABEL[health.verdict],
    checked: checkedClause(health, now),
    detail,
    ...(secondary === undefined ? {} : { secondary }),
    tone: VERDICT_TONE[health.verdict],
    offersSignIn: accountHealthOffersSignIn(health),
    // A verdict AND its reason, both: `unknown` on its own is a real state somebody looked at and
    // could not conclude, which is a different row from one nobody has opened yet.
    quiet: health.verdict === 'unknown' && health.reason === 'never_checked',
    // A row that went stale says WHAT went stale, so its detail is never the reason's own sentence.
    detailIsImplied: health.staleVerdict === undefined && REASON_IS_IMPLIED[health.reason],
    ...(provenance === undefined ? {} : { seedProvenance: provenance }),
  };
}

function checkedClause(health: PickerAccountHealth, now: number): string {
  if (health.lastCheckedAt === null) return 'Never checked';
  if (health.verdictAt !== null && health.lastCheckInconclusive) {
    return `Confirmed ${relativeInstantLabel(health.verdictAt, now)}`;
  }
  return `Checked ${relativeInstantLabel(health.lastCheckedAt, now)}`;
}

/** The row for an account the daemon published no health for at all: unread, not unhealthy. */
export const UNREAD_ACCOUNT_HEALTH: AccountHealthView = Object.freeze({
  label: 'Unknown',
  checked: 'Never checked',
  detail: REASON_DETAIL.never_checked,
  tone: 'muted' as const,
  offersSignIn: false,
  quiet: true,
  detailIsImplied: true,
});
