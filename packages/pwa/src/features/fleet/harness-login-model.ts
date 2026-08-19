/**
 * What a sign-in surface SAYS — the pure half, so every sentence a person reads is pinned by a test.
 *
 * Three rules run through all of it:
 *
 * 1. **A control that cannot act still explains itself.** When a login does not apply, this composes the
 *    sentence naming where the credential DOES come from. Silence there reads as a broken account, and a
 *    greyed-out button with no explanation is the dead end this whole feature exists to remove.
 * 2. **Unknown is never zero.** A usage window nobody measured renders as the word "unknown", never as
 *    `0%` and never as an empty bar — because an empty bar reads as "none used", which is the opposite
 *    of what a failed probe means.
 * 3. **Direction is stated, every time.** Every percentage here is followed by the word "used". A bare
 *    number beside a quota is read in both directions by two different people, which has already cost
 *    this project real time.
 *
 * The daemon owns the FACTS — the credential source, the classification, the measurement — and this owns
 * the PROSE. Splitting it that way is why the daemon's wire contract carries no display strings: two
 * owners for one sentence is how a refusal ends up worded differently in two places.
 */

import type { FleetCredentialReading, FleetCredentialSource, UsageAccountView } from '@ferretry/protocol';

/** How a credential source reads on screen: a short label, and the sentence that acts on it. */
export interface CredentialSourceCopy {
  /** Four words at most — it sits in a badge beside the account. */
  readonly label: string;
  /** Where the credential comes from, as one sentence a person can act on. */
  readonly detail: string;
}

/**
 * Where this account's credential comes from, in words.
 *
 * `undeclared` deliberately does not guess. An account that authenticates with a key and declares nowhere
 * the key comes from is a configuration nobody finished, and saying "from the environment" would send
 * somebody to look at a variable that does not exist.
 */
export function credentialSourceCopy(source: FleetCredentialSource): CredentialSourceCopy {
  if (source.source === 'token-file') {
    return {
      label: 'From a file',
      detail: `This account authenticates with ${source.variable}, which the wrapper reads from ${source.path}. There is no sign-in to run for it.`,
    };
  }
  if (source.source === 'environment') {
    return {
      label: 'From the environment',
      detail: `This account authenticates with ${source.variable}, taken from the environment its wrapper is launched in. There is no sign-in to run for it.`,
    };
  }
  if (source.source === 'configured-value') {
    return {
      label: 'From the configuration',
      detail: `This account authenticates with ${source.variable}, whose value the fleet configuration carries. There is no sign-in to run for it.`,
    };
  }
  if (source.source === 'undeclared') {
    return {
      label: 'Not declared',
      detail:
        'This account authenticates with a key, and nothing in this fleet’s configuration says where that key comes from. Declare it on the host before expecting this account to run.',
    };
  }
  return {
    label: 'From signing in',
    detail: 'The harness writes this account’s credential into its own store when somebody signs in.',
  };
}

/** Humanised time until an instant, or `null` when there is nothing to say. */
export function timeUntil(iso: string | undefined, nowMs: number): string | null {
  if (iso === undefined) return null;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  const minutes = Math.round((at - nowMs) / 60_000);
  if (minutes <= 0) return 'now';
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h`;
  return `${String(Math.round(hours / 24))}d`;
}

/**
 * What the credential store found, as one line.
 *
 * `unreadable` carries the daemon's own reason rather than a phrase of this module's: a locked keychain
 * and a credential a newer harness wrote are different problems, and only the host knows which it met.
 */
export function credentialStateCopy(reading: FleetCredentialReading, nowMs: number): string {
  if (reading.state === 'valid') {
    const left = timeUntil(reading.expiresAt, nowMs);
    return left === null ? 'Signed in' : `Signed in · expires in ${left}`;
  }
  if (reading.state === 'refreshable') {
    // NOT "expired". A refresh token renews itself the first time the account runs, so an expired access
    // token usually costs nobody anything — calling it expired invites a sign-in nothing needed.
    //
    // "IF THE PROVIDER STILL ACCEPTS IT" IS NOT HEDGING. A refresh the provider REJECTS makes Claude Code
    // zero its own credential — access token, refresh token and expiry — measured at 2.1.220 against a
    // throwaway home (#375). So this state can become `missing` with nobody having touched the account,
    // and a sentence promising renewal would have made that transition look like a defect.
    return 'Signed in · renews itself on next use, if the provider still accepts it';
  }
  if (reading.state === 'missing') return 'Not signed in';
  if (reading.state === 'unreadable') return `Could not be read — ${reading.reason}`;
  return 'Nothing was read: this account’s credential does not come from a sign-in';
}

/** One measured window, with its direction in the value rather than assumed by the reader. */
export interface UsageWindowReadout {
  /** The provider's own name for the window. `5h` and `weekly` are what it calls them. */
  readonly window: '5h' | 'weekly';
  /** `null` when the provider answered without a measurement for this window. */
  readonly usedPercent: number | null;
  readonly resetsIn: string | null;
}

/**
 * What can honestly be said about one account's usage.
 *
 * Four states, because there are four different truths and three of them are not a number:
 *
 * - `windows` — a real measurement, in the provider's own windows.
 * - `token-based` — this account is metered per token and has no window. It gets a sentence, never a
 *   percentage of something that does not exist.
 * - `signed-out` — the credential is repudiated, which is a different problem from a quota and says so.
 * - `unknown` — nothing measured it, or the answer carried no measurement. NOT zero.
 */
export type AccountUsageReadout =
  | { readonly kind: 'windows'; readonly windows: readonly UsageWindowReadout[]; readonly atLimit: boolean }
  | { readonly kind: 'token-based' }
  | { readonly kind: 'signed-out' }
  | { readonly kind: 'unknown'; readonly reason: string };

/**
 * One account's usage, from the daemon's cached feed.
 *
 * ## THE PROPERTY THIS RESTS ON, WHICH A FUTURE READER MUST NOT DEFAULT AWAY
 *
 * `usageBased` is only present when the probe actually SUCCEEDED — the daemon carries it from a
 * successful reading and omits it otherwise. That is what makes "nothing measured this" structurally
 * distinguishable from "this was measured at 0%". Defaulting the field, on either side, deletes the
 * distinction and turns every unprobed account into a confident zero.
 *
 * So an absent `usageBased` is `unknown` here, and it is the only honest answer: a Codex account on this
 * build reaches the wire with no measurement at all, because the shipped probe does not apply to one.
 * That is not "token-based" — a ChatGPT subscription does have windows; nobody read them.
 */
export function accountUsageReadout(row: UsageAccountView | undefined, nowMs: number): AccountUsageReadout {
  if (row === undefined) {
    return { kind: 'unknown', reason: 'this daemon has no usage reading for this wrapper yet' };
  }
  if (row.authOk === false) return { kind: 'signed-out' };
  if (row.usageBased === false) return { kind: 'token-based' };
  if (row.usageBased === undefined) {
    return { kind: 'unknown', reason: 'nothing on this host has measured this account’s usage' };
  }
  if (row.fiveHourPercent === undefined && row.weeklyPercent === undefined) {
    return { kind: 'unknown', reason: 'the provider answered without a usage measurement' };
  }
  return {
    kind: 'windows',
    atLimit: row.atLimit === true,
    windows: [
      {
        window: '5h',
        usedPercent: row.fiveHourPercent ?? null,
        resetsIn: resetIn(row.fiveHourResetAt, nowMs),
      },
      {
        window: 'weekly',
        usedPercent: row.weeklyPercent ?? null,
        resetsIn: resetIn(row.weeklyResetAt, nowMs),
      },
    ],
  };
}

/** Epoch milliseconds as a countdown, or `null`. Shares {@link timeUntil}'s rounding. */
function resetIn(at: number | undefined, nowMs: number): string | null {
  return at === undefined ? null : timeUntil(new Date(at).toISOString(), nowMs);
}

/** One window as a phrase whose direction cannot be misread. */
export function usageWindowLabel(readout: UsageWindowReadout): string {
  const value = readout.usedPercent === null ? 'unknown' : `${String(Math.round(readout.usedPercent))}% used`;
  return readout.resetsIn === null
    ? `${readout.window} ${value}`
    : `${readout.window} ${value} · resets in ${readout.resetsIn}`;
}

/** The whole usage readout as one line, for a row too narrow for a table. */
export function usageSummary(readout: AccountUsageReadout): string {
  if (readout.kind === 'token-based') return 'Token-based — no quota window to report';
  if (readout.kind === 'signed-out') return 'Not signed in — usage cannot be read';
  if (readout.kind === 'unknown') return `Usage unknown — ${readout.reason}`;
  const windows = readout.windows.map(usageWindowLabel).join(' · ');
  return readout.atLimit ? `${windows} · at limit` : windows;
}
