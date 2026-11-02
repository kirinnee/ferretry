/**
 * What Jev did before an LLM investigation, as the one compact line shown beside it — on its act in Recent
 * actions, on the investigation's own row, and in its report. Pure.
 *
 * NEVER AMBIGUOUS. The owner asked "if Jev is enabled, it means Jev executed, right?" — and it did not
 * always: the layer can be off, its cap spent, the flag one Jev never judges, the run forced. Every case
 * has its own words, and a result from before the daemon kept them says so rather than saying nothing.
 */

import type { WardenJevBefore } from '@ferretry/protocol';

/** `96%` — the overview's own rounding, kept here so the overview's rows can import this module. */
const percent = (confidence: number): string => `${Math.round(confidence * 100)}%`;

/** One Jev call costs a fraction of a cent, so its price is shown to four places: `$0.0041`. */
export const jevCost = (usd: number): string => `$${usd.toFixed(4)}`;

type JevAct = NonNullable<WardenJevBefore['act']>;

const DO: Readonly<Record<JevAct, string>> = {
  nudge: 'nudge it',
  resume: 'resume it',
  restart: 'restart it',
  stop: 'stop it',
  failover: 'move it to another AI login',
};

const DONE: Readonly<Record<JevAct, string>> = {
  nudge: 'nudged it',
  resume: 'resumed it',
  restart: 'restarted it',
  stop: 'stopped it',
  failover: 'moved it to another AI login',
};

/** What Jev made of a flag it checked and passed on, before its cost. */
const handedOnCause = (jev: WardenJevBefore): string => {
  const sure = percent(jev.confidence ?? 0);
  const act = jev.act;
  switch (jev.why) {
    case 'not_sure_enough':
      return act === undefined ? `only ${sure} sure` : `only ${sure} sure it should ${DO[act]}`;
    case 'never_alone':
    case 'not_allowed':
      return act === undefined
        ? `${sure} sure, not its to do alone`
        : `would ${DO[act]} (${sure}), not its to do alone`;
    case 'cannot_choose_login':
      return `would move it to another AI login (${sure}), cannot pick which`;
    case 'no_message':
      return `would nudge it (${sure}), no message it was sure of`;
    case 'not_offered':
      return 'chose an act this flag does not allow';
    case 'failed':
      return 'call failed';
    case 'act_failed':
      return act === undefined ? `acted (${sure}), it did not take` : `tried to ${DO[act]} (${sure}), it did not take`;
    default:
      return `not sure (${sure})`;
  }
};

/** Why Jev was not asked about a flag. */
const notAskedCause = (jev: WardenJevBefore): string => {
  switch (jev.why) {
    case 'owner_request':
      return 'not asked — you asked for this';
    case 'forced':
      return 'not asked — a forced run';
    case 'not_judgeable':
      return 'not asked — it does not judge this kind of flag';
    case 'backoff':
      return 'not asked — backing off after a rate limit';
    case 'unredacted':
      return 'not asked — the snapshot could not be masked';
    case 'already_acted':
      return jev.act === undefined
        ? 'already acted — still flagged'
        : `already ${DONE[jev.act]} (${percent(jev.confidence ?? 0)}) — still flagged`;
    default:
      return 'no record — queued before Jev’s checks were kept';
  }
};

/**
 * The line for one investigation: `Jev: not sure (21%) · $0.0041 → investigated`, `Jev: skipped — daily cap
 * spent → investigated`, `Jev: off`. `undefined` is a result from a daemon that did not keep it; a fleet
 * triage whose flags Jev answered differently says so.
 */
export function jevBeforeLine(jev: WardenJevBefore | undefined, scope: 'session' | 'fleet' = 'session'): string {
  if (jev === undefined)
    return scope === 'fleet' ? 'Jev: differs per flag' : 'Jev: no record — from before Jev’s results were kept';
  switch (jev.verdict) {
    case 'off':
      return 'Jev: off';
    case 'not_asked':
      return `Jev: ${notAskedCause(jev)}`;
    case 'skipped':
      return `Jev: skipped — ${jev.why === 'jev_paced' ? 'this hour’s share of its cap spent' : 'daily cap spent'} → investigated`;
    case 'handed_on':
      return `Jev: ${handedOnCause(jev)}${jev.costUsd === undefined || jev.costUsd === 0 ? '' : ` · ${jevCost(jev.costUsd)}`} → investigated`;
  }
}
