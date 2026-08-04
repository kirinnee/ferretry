/**
 * Choosing the account a stranded session moves to.
 *
 * EVERY REJECTION IS RECORDED WITH ITS REASON, not filtered away. A failover that finds no target is
 * the most important thing this subsystem can report — it means the whole pool is out of tokens — and
 * "no candidate" with no account of why is indistinguishable from a misconfigured pool, a manifest
 * the daemon could not read, or a feed that has scored nothing. The reasons are what a human reads
 * when the session did not move.
 *
 * SAME-KIND IS DECIDED BY THE MIGRATION'S OWN RULE, reached through {@link harnessMigrationRefusal}
 * rather than restated as `a.kind === b.kind`. There is one definition of what families are
 * compatible and one wording for why crossing them is unrecoverable; a second copy here could accept
 * a move the migrator is about to refuse, which would spend a session's retry cooldown to learn
 * something this daemon already knew.
 *
 * THE CHEAPEST CONFIRMED ACCOUNT WINS. Ranking by measured consumption is the point: the pool's
 * emptiest account is the one most likely to still be there at the end of the session's next turn.
 * Ties break on the operator's configured order, which is why the pool is a list and not a set.
 *
 * Pure: no IO, no clock, no globals.
 */

import type { AccountUsage } from '@ferretry/protocol';
import { type CoreAccount, findAccountByAgent } from '../core/inventory.ts';
import { harnessMigrationRefusal } from '../migrate/harness-compatibility.ts';
import { usageForAgent } from '../usage/account-health.ts';
import { headroom } from './evidence.ts';

export interface FailoverCandidateInput {
  /** The account the session is on now — never a target, and named so the refusal can say so. */
  readonly sourceAgent: string;
  /** The harness family recorded on the session's own configuration document. */
  readonly sourceHarness: string;
  /** The opted-in pool, in the operator's preference order. */
  readonly pool: readonly string[];
  /** The published fleet manifest. */
  readonly accounts: readonly CoreAccount[];
  /** The usage snapshot every headroom claim is measured from. */
  readonly usage: readonly AccountUsage[];
  readonly headroomPercent: number;
  /** Accounts the ledger bars for this session, mapped to why. */
  readonly barred: ReadonlyMap<string, string>;
}

export interface FailoverTarget {
  readonly agent: string;
  /** The measurement the choice was made on, quoted in the journal entry. */
  readonly spentPercent: number;
}

export interface FailoverSelection {
  /** The chosen account, or `undefined` when nothing in the pool qualified. */
  readonly target: FailoverTarget | undefined;
  /** Why each account that was not chosen was not chosen, keyed by agent. */
  readonly rejected: Readonly<Record<string, string>>;
}

/** Picks the emptiest confirmed same-kind account in the pool, or states why there is none. */
export function selectFailoverTarget(input: FailoverCandidateInput): FailoverSelection {
  const rejected: Record<string, string> = {};
  const eligible: FailoverTarget[] = [];

  for (const agent of input.pool) {
    const reason = candidateRefusal(agent, input);
    if (typeof reason === 'string') {
      rejected[agent] = reason;
      continue;
    }
    eligible.push({ agent, spentPercent: reason.spentPercent });
  }

  // Strictly less-than, over a list already in pool order, so a tie keeps the operator's preferred
  // spelling without the comparison having to carry positions around to say so.
  const best = eligible.reduce<FailoverTarget | undefined>(
    (chosen, entry) => (chosen === undefined || entry.spentPercent < chosen.spentPercent ? entry : chosen),
    undefined,
  );

  // Everything eligible that was not chosen still gets a reason: an operator comparing two healthy
  // accounts must be able to see it was the measurement that decided, not an accident of ordering.
  if (best !== undefined) {
    for (const entry of eligible) {
      if (entry === best) continue;
      rejected[entry.agent] = `usable at ${entry.spentPercent}%, but ${best.agent} is emptier at ${best.spentPercent}%`;
    }
  }

  return { target: best, rejected };
}

/** Why one pool entry is not a target, or the headroom it was confirmed at. */
function candidateRefusal(agent: string, input: FailoverCandidateInput): string | { readonly spentPercent: number } {
  if (agent === input.sourceAgent) return 'it is the account this session is already on';
  const barred = input.barred.get(agent);
  if (barred !== undefined) return barred;
  const account = findAccountByAgent(input.accounts, agent);
  // Ambiguity is a refusal in `findAccountByAgent` too: two manifest rows publishing one executable
  // is a defect, and picking either would attach one account's quota to the other's session.
  if (account === undefined) return 'no single account in the published fleet manifest is named by this executable';
  const mismatch = harnessMigrationRefusal({
    sourceHarness: input.sourceHarness,
    targetHarness: account.kind,
    targetAgent: account.agent,
  });
  if (mismatch !== undefined) return mismatch;
  // The manifest's own statement, checked before the feed's: an account declared down is down
  // whatever its quota looks like, and the manifest is the fleet operator speaking directly.
  if (!account.available) return account.unavailableReason ?? 'the fleet manifest declares this account unavailable';
  const verdict = headroom(usageForAgent(input.usage, agent), input.headroomPercent);
  return verdict.confirmed ? { spentPercent: verdict.spentPercent } : verdict.reason;
}
