/**
 * ACCOUNT HEALTH — "is this account signed in", answered without spending a cent.
 *
 * ## What replaced what, and why
 *
 * This used to mean "can this wrapper answer a sentinel prompt?". Answering it LAUNCHED the account's
 * agent and asked a model to reply with an exact string: a real, billable turn, per account, every
 * time anybody looked. The daemon reached it on a fixed timer, so a fleet of thirty accounts bought
 * thirty model calls a tick, forever, on behalf of nobody. `646596a7` cut the timer's reach into it;
 * this module deletes the question.
 *
 * The replacement asks a narrower question and gets it for free:
 *
 *   > Was this account's CURRENT credential recently accepted by its provider?
 *
 * `healthy` therefore means "the credential works", NOT "this account has quota", "every model is
 * entitled" or "the provider is up". Quota is a separate fact with its own fields, and conflating
 * them is how a reader concludes an exhausted account needs a new login.
 *
 * ## Zero spend is structural here, not a policy
 *
 * Nothing in this module launches a process, opens a socket or sends a request. It takes a usage
 * snapshot somebody else already collected — one read-only `GET /api/oauth/usage`, which consumes no
 * inference quota — plus a LOCAL credential classification, and returns a verdict. There is no seam
 * to hang a spend on: {@link FleetCredentialClassifier} returns a state and an opaque fingerprint,
 * and {@link observeAccountHealth} is a pure function of values.
 *
 * That is also why health has no timer of its own. It rides the usage collection that already runs,
 * so an account's verdict refreshes as a side effect of a read the daemon was making anyway. A second
 * cadence would double the provider calls to learn nothing new.
 *
 * ## The rule that matters most
 *
 * An Anthropic-shaped JSON `403` from the read-only usage endpoint is **HEALTHY**. It means the token
 * lacks `user:profile`, which is permanent and expected for an inference-scoped token, and says
 * nothing about whether the account works. An HTML `403` can instead be an edge challenge and proves
 * nothing. The adapter retains a secret-safe response fingerprint so those same-status answers do not
 * collapse into one claim.
 *
 * A bare control-plane `401` is inconclusive too: this client cannot yet distinguish repudiation of
 * the login from refusal of the HTTP client itself. Telling somebody to sign in again from that status
 * alone is worse than admitting the check could not tell.
 *
 * ## Codex is honestly unknown, and that is the finished answer
 *
 * There is no proven non-mutating Codex liveness signal. Its usage endpoint answers `200` for tokens
 * that are already stale, so a `200` there cannot create `healthy`; a forced refresh COULD prove it,
 * but Codex refresh tokens rotate and are single-use, so refreshing to measure would risk breaking
 * the credential being measured and would need a cross-process identity lock that does not exist.
 * `unknown/codex_liveness_unproven` is therefore the correct published verdict rather than a gap in
 * this implementation, and inventing a verdict for it would be worse than saying so.
 *
 * ## Absence of evidence, three times over
 *
 * `unknown` is not a softer `needs_relogin`, "nobody has checked" is not `unknown` (it is
 * `never_checked`, and `lastCheckedAt` is genuinely `null`), and a locally VALID credential is not
 * `healthy` — a current access token can have been revoked minutes ago. Each of those pairs is one
 * collapsed branch away from telling somebody their working fleet is broken.
 *
 * Nothing here reads, writes, hashes or names credential material. Classification takes a state a
 * caller already derived; the material itself stays behind an adapter, exactly as `./identity.ts`
 * requires.
 */
import { z } from 'zod';
import type { FleetConfig } from './config.ts';
import { credentialSourceOf, decideLoginApplicability } from './credential-source.ts';
import type { CredentialState } from './identity.ts';
import type { FleetManifest, FleetManifestAccount, HarnessKind } from './manifest.ts';
import { resolveAccounts } from './profiles.ts';
import type { FleetCredentialSignal, FleetUsage, FleetUsageSnapshot, ProviderResponseFingerprint } from './usage.ts';
import { ProviderResponseFingerprintSchema } from './usage.ts';

const epochMilliseconds = z.number().int().nonnegative().refine(Number.isFinite, 'expected a finite number');

/**
 * How long a conclusive verdict stays trustworthy.
 *
 * A constant rather than configuration, because there is no cost to trade off any more: the evidence
 * arrives with a read the daemon already makes on its own cadence, so an operator tuning this would
 * only be choosing how long to keep believing a number nobody is paying for. Fifteen minutes against
 * the usage pass's one-minute default means a conclusion is normally re-proved fourteen times before
 * it could ever expire, and a fleet whose provider is unreachable degrades to `unknown` rather than
 * quietly showing a verdict from an hour ago.
 *
 * IT EXPIRES NEGATIVE VERDICTS TOO. Somebody who signs in again outside Ferretry — in a terminal, in
 * another tool — must not stay condemned by a `401` this daemon happened to observe first.
 */
export const FLEET_HEALTH_FRESH_MS = 15 * 60 * 1_000;

/**
 * The four public verdicts.
 *
 * `needs_credentials` is not a politer `needs_relogin`, and separating them is the whole point: an
 * account whose credential comes from an environment variable or a token file CANNOT be fixed by an
 * interactive login. The harness reads that value and never consults its own credential store, so a
 * login would open a browser, write a store nobody reads, and change nothing. Offering it is worse
 * than offering nothing, so a reader gets "replace the credential" and the place it comes from.
 */
export const FleetHealthVerdictSchema = z.enum(['healthy', 'needs_relogin', 'needs_credentials', 'unknown']);
export type FleetHealthVerdict = z.infer<typeof FleetHealthVerdictSchema>;

/**
 * WHY the verdict is what it is, as a closed set.
 *
 * A closed set rather than a sentence, because both ends render it: the daemon publishes a code and
 * the browser and the terminal each own their own words for it. A free-text reason would mean the
 * daemon writing UI copy, and two surfaces eventually disagreeing about what a `403` means.
 *
 * Never a message from a provider, never anything derived from credential material.
 */
export const FleetHealthReasonSchema = z.enum([
  // healthy
  /** The provider answered for this exact token. */
  'provider_accepted',
  /** Anthropic JSON `403`: accepted, and usage is not readable. Healthy; the QUOTA is what is unknown. */
  'usage_scope_unavailable',
  // needs_relogin
  /** There is no OAuth material in this home at all. */
  'oauth_credential_missing',
  /** The access token has expired and there is no refresh token to renew it with. */
  'oauth_access_expired',
  /** A provider rejection established by evidence stronger than this probe's ambiguous bare `401`. */
  'oauth_token_rejected',
  // needs_credentials
  /** A non-login credential (env var, token file, configured value) is absent. */
  'static_credential_missing',
  /** A non-login credential was rejected by the provider. */
  'static_credential_rejected',
  // unknown
  /** No check has ever produced evidence for this account. `lastCheckedAt` is `null`. */
  'never_checked',
  /** The credential could not be read or understood. Unknown, and never safe to overwrite. */
  'credential_unreadable',
  /** Expired access WITH a refresh token. Not signed out — unproven until something renews it. */
  'oauth_refreshable',
  /**
   * `401` that cannot be attributed: the provider refused, and this cannot tell WHICH it refused.
   *
   * A rejection of the login and a rejection of the client this request came from arrive as the same
   * status, so reading one as the other sends somebody to sign in again over a login that is fine —
   * the worst outcome available here, because it costs a browser approval and fixes nothing. So the
   * verdict is `unknown` and no surface offers a sign-in for it; see `docs/fleet-health.md`.
   *
   * THE DECISION THAT EMITS THIS LANDS SEPARATELY. It is declared here first because the terminal and
   * the browser both render an exhaustive map over this enum: without the code, the two surfaces
   * cannot be taught the words, and the branch that produces it cannot typecheck.
   */
  'oauth_rejection_unconfirmed',
  /** Codex: no non-mutating liveness signal exists. See the module note. */
  'codex_liveness_unproven',
  /** The free read did not finish inside its deadline. */
  'check_timeout',
  /** The provider was reached and said nothing usable: 5xx, 429, another 4xx, a transport failure. */
  'provider_unavailable',
  /** Locally signed in, and no provider read has confirmed it. Structural evidence only. */
  'provider_not_asked',
  /** The credential was replaced while the check was running, so its result cannot be attributed. */
  'credential_changed_during_check',
  /** The manifest declares this account unavailable, so nothing was checked. */
  'account_unavailable',
  /** A conclusion existed and has aged past {@link FLEET_HEALTH_FRESH_MS}. */
  'stale',
]);
export type FleetHealthReason = z.infer<typeof FleetHealthReasonSchema>;

/** Which kind of evidence the verdict rests on. `none` means it rests on the absence of any. */
export const FleetHealthEvidenceSchema = z.enum(['anthropic_usage', 'local_credential', 'none']);
export type FleetHealthEvidence = z.infer<typeof FleetHealthEvidenceSchema>;

/**
 * One account's published health.
 *
 * `lastCheckedAt` is NULLABLE and that is load-bearing. The contract it replaces required a number,
 * so an account nobody had checked was published with a fabricated "now" — which is the same shape
 * on the wire as a check that just succeeded. A reader cannot tell those apart, and the whole feature
 * exists so that they can.
 */
export const FleetAccountHealthSchema = z.strictObject({
  accountId: z.string().min(1),
  /**
   * The harness as the fleet names it, not a closed set. A daemon that grows a third harness stays
   * conformant; narrowing it here would fail an unfamiliar row and take its siblings with it.
   */
  kind: z.string().min(1),
  /** The EFFECTIVE verdict, after staleness. A conclusion too old to trust publishes `unknown`. */
  verdict: FleetHealthVerdictSchema,
  reason: FleetHealthReasonSchema,
  evidence: FleetHealthEvidenceSchema,
  /** When the latest actual check completed. `null` means no check has ever run for this account. */
  lastCheckedAt: epochMilliseconds.nullable(),
  /**
   * When the evidence behind `verdict` was observed. Can be OLDER than `lastCheckedAt`: a newer
   * inconclusive check moves the check time without disturbing a conclusion that still stands.
   */
  verdictAt: epochMilliseconds.nullable(),
  /**
   * The newest check could not conclude, and `verdict` rests on older evidence. A reader is told
   * both — "Healthy · Confirmed 8m ago" with "last check 1m ago was inconclusive" — because hiding
   * the failed attempt is how a fleet looks fine while every provider call is failing.
   */
  lastCheckInconclusive: z.boolean(),
  /** Secret-safe shape of the newest completed provider response, when there was one. */
  responseFingerprint: ProviderResponseFingerprintSchema.optional(),
  /** What the conclusion WAS before it went stale. Present only when `reason` is `stale`. */
  staleVerdict: FleetHealthVerdictSchema.optional(),
});
export type FleetAccountHealth = z.infer<typeof FleetAccountHealthSchema>;

/** One row per manifest account, always. An account with nothing known is published as unknown. */
export const FleetHealthSnapshotSchema = z.strictObject({
  at: epochMilliseconds,
  accounts: z.array(FleetAccountHealthSchema),
});
export type FleetHealthSnapshot = z.infer<typeof FleetHealthSnapshotSchema>;

export interface FleetHealthClock {
  now(): number;
}

/**
 * What a LOCAL credential read found. Produced by an adapter; no material reaches this module.
 *
 * `fingerprint` is an opaque, non-reversible digest of the material, and it exists for exactly one
 * job: proving whether the credential CHANGED between two observations. It is never a token, never
 * derived in a way that can be reversed, and absent whenever there was no material to digest.
 */
export interface LocalCredentialReading {
  readonly state: CredentialState;
  readonly fingerprint?: string;
  /** Epoch milliseconds the access token expires, when the credential said so. */
  readonly expiresAt?: number;
}

/** Reading and classifying one account home's credential. The sole impure boundary. */
export interface FleetCredentialClassifier {
  classify(account: FleetManifestAccount): Promise<LocalCredentialReading>;
}

/** Everything the verdict is decided from, for one account. Values only. */
export interface AccountHealthInput {
  readonly kind: HarnessKind;
  /** Whether an interactive login could fix this account. Derived from the DECLARED credential source. */
  readonly loginApplies: boolean;
  /** The manifest's own availability. An unavailable account is not evidence about its credential. */
  readonly available: boolean;
  readonly local: LocalCredentialReading | undefined;
  /** What the free provider read established, when a probe spoke for this account at all. */
  readonly remote: FleetCredentialSignal | undefined;
}

/** A verdict, and whether it is strong enough to overwrite a stored one. */
export interface AccountHealthConclusion {
  readonly verdict: FleetHealthVerdict;
  readonly reason: FleetHealthReason;
  readonly evidence: FleetHealthEvidence;
  /**
   * Whether this settles the question. Only a positively dead local credential and a conclusive
   * provider answer do; everything else is a report that nothing was learned, and must not erase a
   * conclusion that is still fresh.
   */
  readonly conclusive: boolean;
}

const conclusion = (
  verdict: FleetHealthVerdict,
  reason: FleetHealthReason,
  evidence: FleetHealthEvidence,
  conclusive: boolean,
): AccountHealthConclusion => ({ verdict, reason, evidence, conclusive });

const unknown = (reason: FleetHealthReason, evidence: FleetHealthEvidence = 'none'): AccountHealthConclusion =>
  conclusion('unknown', reason, evidence, false);

/**
 * The whole verdict table, in one ordered pass.
 *
 * ORDER IS THE DESIGN, so it is spelled out here rather than left to be reconstructed from branches:
 *
 * 1. **An unavailable account is not checked.** The manifest already said it cannot serve work, and a
 *    credential verdict about it would be a claim nothing measured.
 * 2. **A decisive LOCAL expiry classification outranks any remote answer.** The credential classifier
 *    applies the shared 60-second expiry skew before this table runs. `missing` is a hard negative;
 *    `refreshable` is an expired access token with a way back. A remote probe made with that stale
 *    access token may reject it, but that says nothing about whether the refresh token can renew the
 *    login and must never turn the account into `needs_relogin`.
 * 3. **Then the remote answer, which is the only thing that can produce `healthy`.** A locally valid
 *    token is structural evidence, not acceptance: it may have been revoked a minute ago.
 * 4. **Then the most specific inconclusive reason available.** Each of these is a different sentence
 *    a reader acts on differently, so they are ranked rather than collapsed into one "unknown".
 *
 * Pure and total: every input shape returns a verdict, and no branch throws.
 */
export function decideAccountHealth(input: AccountHealthInput): AccountHealthConclusion {
  if (!input.available) return unknown('account_unavailable');

  const local = input.local;
  if (local?.state === 'missing') {
    // Positively absent, or an expired access token with nothing to renew it with. The manifest's own
    // expiry evidence distinguishes those, and they send a reader to two different places.
    const reason: FleetHealthReason =
      local.expiresAt === undefined ? 'oauth_credential_missing' : 'oauth_access_expired';
    return input.loginApplies
      ? conclusion('needs_relogin', reason, 'local_credential', true)
      : conclusion('needs_credentials', 'static_credential_missing', 'local_credential', true);
  }
  if (local?.state === 'refreshable') {
    // The access token is already expired for practical purposes: identity.ts classifies it with the
    // same 60-second skew as the reference implementation. A remote rejection therefore condemns only
    // the stale access token the probe tried, not the refresh token beside it. Refresh first; never ask
    // a person to sign in again while the credential still has a non-interactive recovery path.
    return unknown('oauth_refreshable', 'local_credential');
  }

  /**
   * NO REMOTE SIGNAL COUNTS FOR CODEX, and it is suppressed here rather than checked further down.
   *
   * The Codex branch used to sit BELOW the remote reads, which was safe only because
   * `AnthropicUsageProbe` declines Codex and therefore supplies no signal. That is the probe's
   * RESTRAINT, not a rule — and the seam is public. A later Codex usage probe, model-list read or
   * cached `getAuthStatus` could set `credentialSignal`, and this table would then publish
   * `healthy/provider_accepted` for an account whose usage endpoint answers `200` for tokens that are
   * already STALE. That is the one promise this feature must not break, so it is enforced
   * structurally instead of resting on a collaborator's manners.
   *
   * SUPPRESSED rather than short-circuited, and the difference matters: returning
   * `codex_liveness_unproven` right here would also swallow the more specific reasons BELOW — a Codex
   * home whose credential could not be READ deserves `credential_unreadable`, which is actionable,
   * over "Codex cannot be proved", which is not. Blanking the signal keeps every one of those rows
   * reachable while making the dangerous ones unreachable.
   *
   * A locally dead credential is unaffected: it is decided ABOVE, because that is a fact about this
   * home rather than a claim about the provider.
   */
  const remote = input.kind === 'codex' ? undefined : input.remote;

  if (remote === 'accepted') return conclusion('healthy', 'provider_accepted', 'anthropic_usage', true);
  if (remote === 'scope_unavailable') {
    // THE most important row in this table. See the module note: this is accepted-and-unmeasurable.
    return conclusion('healthy', 'usage_scope_unavailable', 'anthropic_usage', true);
  }
  if (remote === 'rejected') {
    return input.loginApplies
      ? conclusion('needs_relogin', 'oauth_token_rejected', 'anthropic_usage', true)
      : conclusion('needs_credentials', 'static_credential_rejected', 'anthropic_usage', true);
  }
  if (remote === 'rejection_unconfirmed') {
    return unknown('oauth_rejection_unconfirmed', 'anthropic_usage');
  }

  // Nothing conclusive. Say which unknown this is, most specific first.
  if (local?.state === 'unreadable' || remote === 'absent') {
    return unknown('credential_unreadable', 'local_credential');
  }
  if (input.kind === 'codex') return unknown('codex_liveness_unproven');
  if (remote === 'timeout') return unknown('check_timeout', 'anthropic_usage');
  if (remote === 'inconclusive') return unknown('provider_unavailable', 'anthropic_usage');
  if (local?.state === 'valid') return unknown('provider_not_asked', 'local_credential');
  return unknown('never_checked');
}

/** One account's evidence from one pass, ready to be published or merged into a stored head. */
export interface AccountHealthObservation extends AccountHealthConclusion {
  readonly accountId: string;
  readonly kind: string;
  /** When this observation completed. */
  readonly at: number;
  /**
   * The local credential's opaque digest at observation time, when there was material to digest.
   * The only consumer is the change guard that stops a stale rejection landing on a fresh login.
   */
  readonly fingerprint?: string;
  /** Secret-safe shape of the provider response this observation joined, when one completed. */
  readonly responseFingerprint?: ProviderResponseFingerprint;
}

/** Whether an interactive login can fix each declared account. Read from the DECLARATION, never the host. */
function loginApplicability(config: FleetConfig, manifest: FleetManifest): ReadonlyMap<string, boolean> {
  const applies = new Map<string, boolean>();
  for (const resolved of resolveAccounts(config)) {
    const source = credentialSourceOf(resolved, config.secretsFile);
    applies.set(resolved.id, decideLoginApplicability(resolved.kind, source).applies);
  }
  // A published account the configuration no longer declares gets the fail-closed reading: a login is
  // the remedy an OAuth harness offers, and refusing to offer it would leave a reader with no action
  // at all on the one account most likely to be genuinely signed out.
  for (const account of manifest.accounts) if (!applies.has(account.id)) applies.set(account.id, true);
  return applies;
}

/**
 * Join a usage snapshot and a set of local readings into one observation per manifest account.
 *
 * PURE, and deliberately taking the usage snapshot as a VALUE. The daemon has already collected it
 * for the quota feed and the CLI collects it once for the command it was asked to run; a function
 * that collected its own would double the provider calls to learn nothing. There is no code path
 * from here to a request.
 */
export function observeAccountHealth(input: {
  readonly manifest: FleetManifest;
  readonly config: FleetConfig;
  readonly usage: FleetUsageSnapshot;
  readonly local: ReadonlyMap<string, LocalCredentialReading>;
  readonly at: number;
}): readonly AccountHealthObservation[] {
  const applies = loginApplicability(input.config, input.manifest);
  const rows = new Map<string, FleetUsage>(input.usage.accounts.map(row => [row.accountId, row]));
  return [...input.manifest.accounts]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(account => {
      const local = input.local.get(account.id);
      const usage = rows.get(account.id);
      const decided = decideAccountHealth({
        kind: account.kind,
        loginApplies: applies.get(account.id) ?? true,
        available: account.available,
        local,
        remote: usage?.credentialSignal,
      });
      return {
        ...decided,
        accountId: account.id,
        kind: account.kind,
        at: input.at,
        ...(local?.fingerprint === undefined ? {} : { fingerprint: local.fingerprint }),
        ...(usage?.responseFingerprint === undefined ? {} : { responseFingerprint: usage.responseFingerprint }),
      };
    });
}

/**
 * Classify every manifest account's local credential, tolerating a reader that throws.
 *
 * A classifier failure is `unreadable` and never `missing`: one is unknown and the other is a hard
 * negative that condemns a login. A keychain that timed out has told us nothing about whether
 * somebody is signed in.
 */
export async function readLocalCredentials(
  manifest: FleetManifest,
  classifier: FleetCredentialClassifier,
): Promise<ReadonlyMap<string, LocalCredentialReading>> {
  const entries = await Promise.all(
    manifest.accounts.map(async account => {
      try {
        return [account.id, await classifier.classify(account)] as const;
      } catch {
        return [account.id, { state: 'unreadable' as const }] as const;
      }
    }),
  );
  return new Map(entries);
}

/** Publish observations directly, with no persistence. A one-shot answer for a caller who just asked. */
export function healthSnapshotFromObservations(
  observations: readonly AccountHealthObservation[],
  at: number,
): FleetHealthSnapshot {
  return FleetHealthSnapshotSchema.parse({
    at: Math.trunc(at),
    accounts: observations.map(observation => ({
      accountId: observation.accountId,
      kind: observation.kind,
      verdict: observation.verdict,
      reason: observation.reason,
      evidence: observation.evidence,
      lastCheckedAt: observation.at,
      verdictAt: observation.conclusive ? observation.at : null,
      lastCheckInconclusive: !observation.conclusive,
      ...(observation.responseFingerprint === undefined
        ? {}
        : { responseFingerprint: observation.responseFingerprint }),
    })),
  });
}

/**
 * Collecting free health in one process, for a caller who asked for it right now.
 *
 * Used by `fy fleet health`, which has no daemon and therefore no stored head: it collects the free
 * usage read, classifies the local credentials, and publishes what that one pass established. The
 * daemon does not use this — it owns a persisted head, so it reuses {@link observeAccountHealth}
 * against the usage snapshot it collected for the quota feed rather than collecting a second one.
 */
export class FleetHealthCollector {
  constructor(
    private readonly usage: { collect(manifest: FleetManifest): Promise<FleetUsageSnapshot> },
    private readonly credentials: FleetCredentialClassifier,
    private readonly clock: FleetHealthClock,
    private readonly config: FleetConfig,
  ) {}

  async collect(manifest: FleetManifest): Promise<FleetHealthSnapshot> {
    const [usage, local] = await Promise.all([
      this.usage.collect(manifest),
      readLocalCredentials(manifest, this.credentials),
    ]);
    const at = this.#now();
    return healthSnapshotFromObservations(
      observeAccountHealth({ manifest, config: this.config, usage, local, at }),
      at,
    );
  }

  #now(): number {
    const now = this.clock.now();
    if (!Number.isFinite(now) || now < 0) throw new Error('the fleet clock did not return a valid instant');
    return Math.trunc(now);
  }
}

/** The only construction path, so the CLI and the daemon cannot decide a verdict differently. */
export function buildFleetHealthCollector(
  config: FleetConfig,
  usage: { collect(manifest: FleetManifest): Promise<FleetUsageSnapshot> },
  credentials: FleetCredentialClassifier,
  clock: FleetHealthClock,
): FleetHealthCollector {
  return new FleetHealthCollector(usage, credentials, clock, config);
}
