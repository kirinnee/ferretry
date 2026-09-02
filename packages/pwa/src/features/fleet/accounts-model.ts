/**
 * WHAT THE ACCOUNTS PAGE SAYS — the pure half, so every sentence a person reads is pinned by a test.
 *
 * The page joins three answers the daemon already publishes and invents nothing:
 *
 *   - `GET /v1/fleet/login` — which accounts exist, what each one's credential IS, and whether a
 *     sign-in could possibly help it.
 *   - `GET /v1/fleet/health` — what the provider last said, and WHEN. A stored snapshot: reading it
 *     costs one local call and no provider traffic.
 *   - `GET /v1/usage` — the daemon's own cached per-wrapper figures.
 *
 * ## NO THIRD SET OF WORDS
 *
 * The verdict and its instant come from `lib/account-health-view.ts`, which the account picker and
 * every other health surface already read. The credential state, the credential source and the usage
 * line come from `harness-login-model.ts`. This module composes those and owns exactly two new
 * things: the label on a sign-in button, and what one provider login covers.
 *
 * ## ONE ROW PER ACCOUNT, AND THAT IS THE POINT
 *
 * The surface this replaced grouped by IDENTITY and offered one button per group, which started the
 * login of whichever member happened to be listed first. `chooseLoginDriver` exists because that
 * conflated whose wrapper shows the browser with whose credential this is — so a row here carries its
 * OWN `accountId`, and the account somebody clicks is the account that gets signed in.
 */

import { type AccountHealthView, accountHealthView, UNREAD_ACCOUNT_HEALTH } from '../../lib/account-health-view.ts';
import type { PickerAccountHealth } from '../../lib/account-picker-catalog.ts';
import type {
  FleetCredentialSource,
  FleetLoginAccount,
  FleetLoginIdentity,
  FleetLoginReadiness,
  UsageAccountView,
} from '@ferretry/protocol';
import { type FleetHarnessKind, fleetHarnessLabel } from './fleet-model.ts';
import {
  type AccountUsageReadout,
  accountUsageReadout,
  credentialSourceCopy,
  credentialStateCopy,
  usageSummary,
} from './harness-login-model.ts';

/**
 * Whether this row can offer a sign-in, and what it says when it cannot.
 *
 * `unavailable` is not a refusal of the SAME kind as the other two: the credential could be signed in
 * perfectly well, and the reason there is nothing to press is that the fleet publishes this account as
 * unable to run at all. Offering a sign-in for it would spend an approval on a wrapper no session can
 * use; saying nothing would read as a broken control.
 */
export type AccountSignInOffer =
  | { readonly kind: 'offered'; readonly label: string }
  | {
      readonly kind: 'elsewhere';
      /** The daemon's own discriminator, carried so a surface can name it on the DOM rather than in prose. */
      readonly source: FleetCredentialSource['source'];
      readonly badge: string;
      readonly detail: string;
    }
  | { readonly kind: 'unavailable'; readonly detail: string };

/**
 * What one provider login covers, and what the fleet last decided about it.
 *
 * The verdict is the fleet's own five-member union and it is rendered as a SENTENCE rather than as the
 * word `sync` or `indeterminate`. Those are the vocabulary of the configuration schema, and a badge
 * printing one is the same defect as the lane and layer badges that were removed from every screen:
 * a reader meets a word they have to learn before the screen means anything.
 */
export interface AccountLoginCoverage {
  /** `<kind>:<identity>`, so a reader can tell two provider accounts apart. */
  readonly identity: string;
  /** Every account on this login, this one included. */
  readonly memberCount: number;
  /** What a sign-in here reaches. */
  readonly summary: string;
  /** What the fleet decided, when that is worth a sentence, plus its own reason. */
  readonly state: string | undefined;
}

/** One account, as the page prints it. */
export interface AccountRowView {
  readonly accountId: string;
  readonly kind: FleetHarnessKind;
  /** The name a person recognises. */
  readonly label: string;
  /** The executable name — the word somebody types, and the usage feed's join key. */
  readonly wrapper: string;
  readonly mode: 'interactive' | 'auto';
  readonly available: boolean;
  /** What the provider last said, in the words every health surface shares. */
  readonly health: AccountHealthView;
  /**
   * The instant behind `health.checked`, or `null` when nobody has ever looked.
   *
   * Carried separately so the surface can put the exact UTC time in a `<time dateTime>` while the
   * visible label stays the relative one. A relative label alone is not a time.
   */
  readonly checkedAt: number | null;
  /** What the credential store found in this account's own home. */
  readonly credential: string;
  readonly usage: string;
  readonly usageKind: AccountUsageReadout['kind'];
  readonly login: AccountLoginCoverage;
  readonly signIn: AccountSignInOffer;
  /** Offered only for an access token that aged out with a refresh token beside it. */
  readonly renew: AccountRenewOffer;
}

/** Every account of one harness, and the one thing about that harness a person is surprised by. */
export interface AccountsHarnessGroup {
  readonly kind: FleetHarnessKind;
  readonly label: 'Claude' | 'Codex';
  readonly sharing: HarnessSharingNote;
  readonly rows: readonly AccountRowView[];
}

export interface AccountsRosterView {
  /** Only harnesses this daemon actually publishes an account for. */
  readonly groups: readonly AccountsHarnessGroup[];
  readonly total: number;
}

/**
 * WHAT CAN STAND IN FOR A SIGN-IN, per harness. Said on the page, not hidden in a document.
 *
 * Both sentences are about SUBSTITUTION, which is the thing the two harnesses genuinely differ on:
 *
 * - A Claude account's credential can be handed to a wrapper when it launches.
 *   `CLAUDE_CODE_OAUTH_TOKEN` is a recognised credential source
 *   (`packages/fleet/src/lib/credential-source.ts:60`), injection writes no credential file, so there
 *   is nothing per member to go stale — and the harness itself says such a token is inference-only.
 * - A Codex account's cannot. The only environment credential Codex recognises is `OPENAI_API_KEY`
 *   (`:61`), which is API-key auth and NOT the ChatGPT subscription login, and sharing a `CODEX_HOME`
 *   would share that home's instructions, skills, hooks and logs along with its credential — at which
 *   point the members stop being distinct agents.
 *
 * Neither sentence claims a sign-in reaches only one home. The fleet clones a donor credential to the
 * siblings of an identity for BOTH harnesses (`packages/fleet/src/lib/identity.ts`), which is what
 * {@link AccountLoginCoverage} says per row. Merging the two facts into "Codex signs in one home at a
 * time" would be false, and merging them the other way would tell somebody a Codex account can be
 * pointed at a token that does not exist.
 */
export interface HarnessSharingNote {
  /** The claim, in one line. */
  readonly headline: string;
  /** Why, and what it costs. */
  readonly detail: string;
}

export const HARNESS_SHARING: Readonly<Record<FleetHarnessKind, HarnessSharingNote>> = {
  claude: {
    headline: 'A Claude account can serve several members.',
    detail:
      'One sign-in covers every member on the same login, and a Claude OAuth token can stand in for one when a wrapper launches — inference only, with no credential file to go stale.',
  },
  codex: {
    headline: 'A Codex account is signed in per member.',
    detail:
      'Nothing can stand in for a Codex subscription sign-in: an API key is different auth, and sharing a Codex home would share its instructions, skills and logs too.',
  },
};

/** `Sign in` for an account with no credential, `Sign in again` for one that already has one. */
const signInLabel = (account: FleetLoginAccount): string =>
  account.credential.state === 'missing' ? 'Sign in' : 'Sign in again';

/**
 * What this row offers, and it is never a control that cannot succeed.
 *
 * The order matters. A credential that does not come from a login can never be fixed by signing in,
 * whatever else is true of the account, so that answer comes first and carries where the credential
 * DOES come from. An account the fleet publishes as unavailable is second: a sign-in would work and
 * would still leave a wrapper no session can launch.
 */
export const accountSignInOffer = (account: FleetLoginAccount): AccountSignInOffer => {
  if (!account.login.applies) {
    const source = credentialSourceCopy(account.source);
    return {
      kind: 'elsewhere',
      source: account.source.source,
      badge: source.label,
      detail: account.login.harnessReason ?? source.detail,
    };
  }
  if (!account.available) {
    return {
      kind: 'unavailable',
      detail: 'This fleet publishes this account as unable to run, so signing it in would change nothing yet.',
    };
  }
  return { kind: 'offered', label: signInLabel(account) };
};

/**
 * Whether this row can offer a renewal, and there is deliberately no "why not".
 *
 * A RENEWAL IS NOT A REMEDY FOR ANYTHING ELSE. It applies to exactly one credential state — an access
 * token that has aged out with a refresh token still beside it — and every other state is either fine
 * or needs a person. So the absent case says nothing at all rather than explaining itself: the row
 * already carries its credential sentence and its sign-in offer, and a third line saying "there is
 * nothing to renew" on every healthy account is noise on the rows that need the least reading.
 *
 * That is the opposite of {@link AccountSignInOffer}'s rule, and the difference is which control a
 * person came looking for. A missing sign-in button is a dead end somebody is actively hunting for;
 * a missing renew button on a signed-in account is the ordinary case.
 */
export type AccountRenewOffer = { readonly kind: 'offered'; readonly label: string } | { readonly kind: 'none' };

/**
 * What this row offers, and it is never a control that cannot succeed.
 *
 * `refreshable` and nothing else. `valid` has nothing to gain and a rotating refresh token to lose;
 * `missing` has no refresh token to spend; `unreadable` is a home nobody could classify, and offering
 * to rotate a credential nobody could read is how a good one gets replaced by nothing. The host
 * refuses all three anyway — `planTokenRefresh` is the gate and this is not a second one — but a
 * button that the host would refuse is still a button that should not be there.
 */
export const accountRenewOffer = (account: FleetLoginAccount): AccountRenewOffer =>
  account.login.applies && account.available && account.credential.state === 'refreshable'
    ? { kind: 'offered', label: 'Renew now' }
    : { kind: 'none' };

/**
 * The fleet's verdict for one login, as a sentence.
 *
 * `complete` earns silence: every member holds a usable credential, and a row that said so would spend
 * a line telling somebody nothing happened. Annotated over the whole union rather than defaulted, so a
 * sixth verdict is a compile error here instead of a state that renders as blank.
 */
const COVERAGE_STATE: Readonly<Record<FleetLoginIdentity['verdict'], string | undefined>> = {
  complete: undefined,
  sync: 'A member of this login has no credential of its own yet. The next sign-in copies one over.',
  login: 'This login needs somebody to sign in.',
  indeterminate: 'A member’s credential could not be read, so nothing is decided about this login.',
  'no-login': 'Nothing here signs in: this login’s credential comes from somewhere else.',
};

const coverageSummary = (memberCount: number): string =>
  memberCount <= 1
    ? 'This login covers this account only.'
    : `This login covers ${String(memberCount)} accounts, this one included.`;

/**
 * The daemon's reason, made into a sentence. Its WORDS are never touched.
 *
 * Every reason the fleet composes is a lowercase clause with no full stop —
 * `this account authenticates with a key`, `no usable credential was found, and 1 of 2 could not be
 * read — refusing to decide` (`packages/fleet/src/lib/identity.ts`). Appended raw after the verdict's
 * own sentence, that renders as a full stop followed by a lowercase fragment that never closes:
 * "…so nothing is decided about this login. no usable credential was found…". Found by reading the
 * screen rather than the type, which is the only place it is visible.
 *
 * A capital and a full stop are TYPOGRAPHY. Rewording the clause here would be a second set of words
 * for a fact the host already stated, which is the thing this module exists not to do.
 */
const asSentence = (reason: string): string => {
  const first = reason.slice(0, 1);
  const opened = first.toLocaleUpperCase() + reason.slice(1);
  return /[.!?]$/u.test(opened) ? opened : `${opened}.`;
};

/**
 * What the fleet decided about this login, for a row that is ALSO saying where its credential is from.
 *
 * `offer` is here because of what the screen looked like. A `no-login` row printed three statements of
 * one fact: "Nothing here signs in: this login's credential comes from somewhere else.", then "This
 * account authenticates with a key.", then — beside the badge — "This account authenticates with
 * ANTHROPIC_API_KEY, which the wrapper reads from /etc/ferretry/secrets.sh. There is no sign-in to run
 * for it." The third is strictly the most useful of the three: it names the variable and the file
 * somebody has to go and look at. The first two are the same sentence with the details removed.
 *
 * So the identity's state yields to the row's own source sentence, and only there. The REACH — how many
 * accounts this login covers — is never dropped, because no other line on the row carries it.
 */
const loginCoverage = (identity: FleetLoginIdentity, offer: AccountSignInOffer): AccountLoginCoverage => {
  const verdict = COVERAGE_STATE[identity.verdict];
  const reason = identity.reason === undefined ? undefined : asSentence(identity.reason);
  // The daemon's own reason is appended rather than replacing the sentence: the verdict says WHAT was
  // decided and the reason says why, and a surface that printed only one of them loses half of it.
  const state = verdict === undefined ? reason : reason === undefined ? verdict : `${verdict} ${reason}`;
  return {
    identity: identity.identity,
    memberCount: identity.accounts.length,
    summary: coverageSummary(identity.accounts.length),
    state: offer.kind === 'elsewhere' ? undefined : state,
  };
};

const accountRow = (
  account: FleetLoginAccount,
  identity: FleetLoginIdentity,
  health: ReadonlyMap<string, PickerAccountHealth>,
  usage: ReadonlyMap<string, UsageAccountView> | undefined,
  now: number,
): AccountRowView => {
  const stored = health.get(account.accountId);
  const readout = accountUsageReadout(usage?.get(account.wrapper), now);
  const signIn = accountSignInOffer(account);
  return {
    accountId: account.accountId,
    kind: account.kind,
    label: account.displayName,
    wrapper: account.wrapper,
    mode: account.mode,
    available: account.available,
    // An account the daemon published no health row for is UNREAD, which is a different fact from an
    // account somebody looked at and could not conclude about. `UNREAD_ACCOUNT_HEALTH` has its own
    // sentence for exactly that, and collapsing the two reads absence of evidence as evidence.
    health: stored === undefined ? UNREAD_ACCOUNT_HEALTH : accountHealthView(stored, now),
    checkedAt: stored?.lastCheckedAt ?? null,
    credential: credentialStateCopy(account.credential, now),
    usage: usageSummary(readout),
    usageKind: readout.kind,
    login: loginCoverage(identity, signIn),
    signIn,
    renew: accountRenewOffer(account),
  };
};

/** Harness order is fixed rather than derived: a roster that reorders itself between reads is unreadable. */
const HARNESS_ORDER: readonly FleetHarnessKind[] = ['claude', 'codex'];

/**
 * Every published account, grouped by harness.
 *
 * Flattened out of the identity tree on purpose. The identity is a fact ABOUT a row — what one sign-in
 * reaches — rather than the thing being listed, and a person reading this page is looking for an
 * account by the name they gave it.
 */
export const accountsRoster = (
  readiness: FleetLoginReadiness,
  health: ReadonlyMap<string, PickerAccountHealth>,
  usage: ReadonlyMap<string, UsageAccountView> | undefined,
  now: number,
): AccountsRosterView => {
  const rows = readiness.identities.flatMap(identity =>
    identity.accounts.map(account => accountRow(account, identity, health, usage, now)),
  );
  const groups = HARNESS_ORDER.map(kind => ({
    kind,
    label: fleetHarnessLabel(kind),
    sharing: HARNESS_SHARING[kind],
    rows: rows.filter(row => row.kind === kind),
  })).filter(group => group.rows.length > 0);
  return { groups, total: rows.length };
};
