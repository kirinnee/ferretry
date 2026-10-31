/**
 * REPORTS OVERDUE: a sub-ferret that has not answered its parent's last message, its turn long ended.
 *
 * ═══ WHY ═══
 *
 * On 2026-10-31 two review sub-ferrets went quiet for hours while their lead waited on their verdicts. One
 * was on a login out of quota: every message ended its turn in half a second. The other's turn was cut
 * off by a provider safety block and ended with nothing sent. Both sat `running` at `your-turn`, which
 * every other check reads as a healthy ferret waiting on its owner: sus and frozen look only at working
 * turns, a question only at `awaiting_*`, a declared wait only at the waiter. Nobody told the lead.
 *
 * ═══ WHAT IT IS ═══
 *
 * Facts only, from the two send ledgers: the parent's newest message to the sub-ferret, and the
 * sub-ferret's newest message to the parent. The parent spoke last, the sub-ferret's turn has ended and
 * it has sat there at least {@link REPORT_OVERDUE_MS} — that is the whole rule. No transcript is judged
 * and Jev is never asked: whether the message "needed" an answer is the parent's to say, and a sub-ferret's
 * job ends in `signal done` (its done marker ends the episode) or a message to its parent either way.
 *
 * ═══ WHO IS TOLD ═══
 *
 * Once per EPISODE: one parent message left unanswered.
 *
 * 1. The sub-ferret is nudged, once, when the owner lets the Warden nudge alone and its login is not at
 *    its limit (a nudge to a ferret that cannot run is a wasted turn);
 * 2. its parent is told — at once when no nudge could help, else once the nudge has had
 *    {@link REPORT_OVERDUE_MS} and the sub-ferret is still silent — with the facts and its ways out.
 *
 * The memory is kept while the sub-ferret lives, not while it is flagged: a nudge starts a turn, and a
 * memory dropped while that turn ran would nudge it again every time the turn ended.
 *
 * Pure: the fleet, the ledgers and the memory arrive through the arguments.
 */
import { inWardenLineage, type WardenAnomaly } from './detect.ts';
import { wardenTeammateToken } from './prompt.ts';
import { isoFromMs, latestInstantMs } from './time.ts';
import { isTerminalStatus, type WardenSessionView } from './types.ts';

/** How long a sub-ferret's turn may have ended, its parent's last message unanswered, before it is overdue. */
export const REPORT_OVERDUE_MS = 20 * 60_000;

/** One send, as far as this module reads it: who sent it, when, whether it asked for a reply. */
export interface ExchangeSend {
  readonly from?: string | undefined;
  readonly acceptedAt: string;
  readonly turn?: number | undefined;
  readonly replyExpected?: boolean | null | undefined;
  readonly fate: string;
}

/** What passed between a sub-ferret and its parent, newest of each way. */
export interface ParentExchange {
  /** The parent's newest message to the sub-ferret. */
  readonly asked?: { readonly at: string; readonly turn?: number; readonly replyExpected: boolean };
  /** When the sub-ferret last sent its parent anything. */
  readonly answeredAt?: string;
}

/** A send that never reached anybody is not a message: it was withdrawn before a key was typed, or cancelled. */
const UNSENT = new Set(['withdrawn', 'cancelled']);

const newestFrom = (sends: readonly ExchangeSend[], from: string): ExchangeSend | undefined => {
  let newest: ExchangeSend | undefined;
  for (const send of sends) {
    if (send.from !== from || UNSENT.has(send.fate)) continue;
    if (newest === undefined || Date.parse(send.acceptedAt) > Date.parse(newest.acceptedAt)) newest = send;
  }
  return newest;
};

/** The exchange the two ledgers record: `childSends` is the sub-ferret's (what it was sent), `parentSends` the parent's. */
export function parentExchangeOf(
  childSends: readonly ExchangeSend[],
  parentSends: readonly ExchangeSend[],
  childId: string,
  parentId: string,
): ParentExchange {
  const asked = newestFrom(childSends, parentId);
  const answered = newestFrom(parentSends, childId);
  return {
    ...(asked === undefined
      ? {}
      : {
          asked: {
            at: asked.acceptedAt,
            ...(asked.turn === undefined ? {} : { turn: asked.turn }),
            replyExpected: asked.replyExpected === true,
          },
        }),
    ...(answered === undefined ? {} : { answeredAt: answered.acceptedAt }),
  };
}

/** The statuses a sub-ferret sits in while its turn has ended: idle at its prompt, or stopped on its quota. */
const ENDED_STATUSES: ReadonlySet<string> = new Set(['running', 'rate_limited']);

/**
 * The sub-ferrets whose ledgers are worth reading this sweep, with their parents: an autonomous ferret,
 * not a warden's, whose parent is alive, that sits with its turn ended for at least `overdueMs`, has
 * declared no wait and has not signalled done. Everything here is a fact the session documents already
 * hold, so the ledgers are opened for a handful of ferrets, not the fleet.
 */
export function overdueCandidates(
  fleet: readonly WardenSessionView[],
  nowMs: number,
  overdueMs: number = REPORT_OVERDUE_MS,
): readonly { readonly child: WardenSessionView; readonly parent: WardenSessionView }[] {
  const byId = new Map(fleet.map(view => [view.config.id, view]));
  const candidates: { child: WardenSessionView; parent: WardenSessionView }[] = [];
  for (const child of fleet) {
    const { config, state } = child;
    if (config.mode !== 'auto' || config.parent === undefined || config.parent === config.id) continue;
    if (!ENDED_STATUSES.has(state.status) || state.turnState !== 'your-turn') continue;
    if (state.waiting !== undefined || child.hasDoneMarker === true) continue;
    const ended = latestInstantMs(state.turnStateAt);
    if (ended === undefined || nowMs - ended < overdueMs) continue;
    const parent = byId.get(config.parent);
    if (parent === undefined || isTerminalStatus(parent.state.status)) continue;
    if (inWardenLineage(child, byId)) continue;
    candidates.push({ child, parent });
  }
  return candidates;
}

/** A ferret as a reference a reader's client can prove and link: its callsign, else its bare id. */
const ferretRef = (view: WardenSessionView): string =>
  view.config.teammate === undefined ? view.config.id : wardenTeammateToken(view.config.teammate);

/** What stopped it, in words, when the documents say. */
const stoppedBy = (child: WardenSessionView): string =>
  child.state.status === 'rate_limited' ? ' Its login is at its usage limit, so it cannot run.' : '';

/** The episode an exchange is: the parent message left unanswered. */
const episodeOf = (childId: string, askedAt: string): string => `report:${childId}|asked:${askedAt}`;

/**
 * One `report_overdue` anomaly per candidate whose parent spoke last. Anchored at the later of the
 * parent's message and the end of the sub-ferret's turn: a message that arrived after the turn ended
 * has had only that long.
 */
export function detectOverdueReports(
  candidates: readonly { readonly child: WardenSessionView; readonly parent: WardenSessionView }[],
  exchanges: ReadonlyMap<string, ParentExchange>,
  nowMs: number,
  overdueMs: number = REPORT_OVERDUE_MS,
): readonly WardenAnomaly[] {
  const anomalies: WardenAnomaly[] = [];
  for (const { child, parent } of candidates) {
    const exchange = exchanges.get(child.config.id);
    const asked = exchange?.asked;
    if (asked === undefined) continue;
    const askedMs = Date.parse(asked.at);
    if (!Number.isFinite(askedMs)) continue;
    if (exchange?.answeredAt !== undefined && Date.parse(exchange.answeredAt) >= askedMs) continue;
    const anchor = latestInstantMs(asked.at, child.state.turnStateAt) ?? askedMs;
    const idleMs = nowMs - anchor;
    if (idleMs < overdueMs) continue;
    const idleMinutes = Math.floor(idleMs / 60_000);
    const askedFor = asked.replyExpected ? ', which asked for a reply,' : '';
    anomalies.push({
      kind: 'report_overdue',
      sessionId: child.config.id,
      ...(child.config.teammate === undefined ? {} : { teammate: child.config.teammate }),
      ...(child.config.label === undefined ? {} : { label: child.config.label }),
      status: child.state.status,
      detail: `has not answered ${ferretRef(parent)}'s message of ${asked.at}${askedFor} and its turn has been over for ${idleMinutes}m.${stoppedBy(child)}`,
      since: isoFromMs(anchor),
      idleMinutes,
      subject: episodeOf(child.config.id, asked.at),
    });
  }
  return anomalies;
}

// ── Escalation ───────────────────────────────────────────────────────────────────────────────────────

/** What the Warden did about one sub-ferret's unanswered message, this episode. */
export interface OverdueTold {
  /** The parent message the episode is about (`ParentExchange.asked.at`). */
  readonly asked: string;
  readonly nudgedAt?: string;
  readonly toldParentAt?: string;
}

/** Every live sub-ferret the Warden acted on, keyed by its session id. */
export type OverdueMemory = Readonly<Record<string, OverdueTold>>;

export type OverdueTell =
  | { readonly kind: 'nudge'; readonly sessionId: string; readonly asked: string; readonly message: string }
  | {
      readonly kind: 'parent';
      /** The parent: whom the message is for. */
      readonly sessionId: string;
      readonly child: string;
      readonly asked: string;
      readonly message: string;
    };

export interface OverduePlan {
  readonly tell: readonly OverdueTell[];
  /** The memory to keep, before any tell is recorded as landed. */
  readonly memory: OverdueMemory;
}

export interface OverduePlanInput {
  /** This sweep's `report_overdue` anomalies. */
  readonly overdue: readonly WardenAnomaly[];
  readonly exchanges: ReadonlyMap<string, ParentExchange>;
  /** Every session this daemon holds, live and finished. */
  readonly fleet: readonly WardenSessionView[];
  readonly memory: OverdueMemory;
  /** Whether the Warden is on: off, nobody is told. */
  readonly enabled: boolean;
  /** Whether the owner lets the Warden nudge a ferret alone. Not: the parent is told at once instead. */
  readonly mayNudge: boolean;
  /** The CLI a ferret actually types. */
  readonly clientName: string;
  readonly nowMs: number;
  readonly overdueMs?: number;
}

/** The nudge a silent sub-ferret is typed. */
export function overdueNudgeMessage(parent: WardenSessionView, minutes: number | undefined, cli: string): string {
  const name = parent.config.teammate ?? parent.config.id;
  const since = minutes === undefined ? '' : ` ${minutes}m ago`;
  return (
    `The Warden checked on you: your turn ended${since} without answering ${ferretRef(parent)}'s last message. ` +
    `Send ${name} your result or status now (\`${cli} send ${name} "<result>"\`), or finish with ` +
    `\`${cli} signal done "<result>"\` if the task is done. If you are blocked, say exactly what you need.`
  );
}

/** The message to the parent, when a nudge could not help or did not. */
export function overdueParentMessage(
  child: WardenSessionView,
  anomaly: WardenAnomaly,
  nudgedAt: string | undefined,
  cli: string,
): string {
  const ref = ferretRef(child);
  const id = child.config.id;
  const why =
    child.state.status === 'rate_limited'
      ? 'Its login is at its usage limit, so it cannot run until the limit resets or it moves to another login.'
      : nudgedAt === undefined
        ? 'Its turn ended without a reply: it may have been cut off (a provider refusal, a crash) or forgotten.'
        : `The Warden nudged it at ${nudgedAt} and it still has not replied.`;
  const idle = anomaly.idleMinutes === undefined ? '' : ` for ${anomaly.idleMinutes}m`;
  return (
    `${ref} has not answered your last message and has been idle${idle}. ${why} ` +
    `Re-ask it (\`${cli} send ${id} "<message>"\`), move it to another login (\`${cli} migrate ${id} --agent <runtime>\`), ` +
    `or stop it and hand its work on (\`${cli} stop cascade ${id} --reason "<why>"\`).`
  );
}

/**
 * Whom to tell about each overdue report this sweep, and what to remember. Deterministic: the same inputs
 * give the same plan in the same order.
 */
export function planOverdueReports(input: OverduePlanInput): OverduePlan {
  const overdueMs = input.overdueMs ?? REPORT_OVERDUE_MS;
  const fleet = new Map(input.fleet.map(view => [view.config.id, view]));
  const tell: OverdueTell[] = [];
  const memory: Record<string, OverdueTold> = {};
  // Kept while the sub-ferret lives: its nudge starts a turn, and a memory dropped while that turn ran
  // would nudge it again the moment the turn ended.
  for (const [sessionId, told] of Object.entries(input.memory)) {
    const child = fleet.get(sessionId);
    if (child !== undefined && !isTerminalStatus(child.state.status)) memory[sessionId] = told;
  }
  for (const anomaly of input.overdue) {
    const child = fleet.get(anomaly.sessionId);
    const parentId = child?.config.parent;
    const parent = parentId === undefined ? undefined : fleet.get(parentId);
    const asked = input.exchanges.get(anomaly.sessionId)?.asked?.at;
    if (child === undefined || parent === undefined || asked === undefined) continue;
    const told = memory[anomaly.sessionId];
    const episode = told?.asked === asked ? told : undefined;
    if (!input.enabled || episode?.toldParentAt !== undefined) continue;
    const limited = child.state.status === 'rate_limited';
    if (episode === undefined && input.mayNudge && !limited) {
      tell.push({
        kind: 'nudge',
        sessionId: child.config.id,
        asked,
        message: overdueNudgeMessage(parent, anomaly.idleMinutes, input.clientName),
      });
      continue;
    }
    const nudgedMs = episode?.nudgedAt === undefined ? undefined : Date.parse(episode.nudgedAt);
    if (nudgedMs !== undefined && !limited && input.nowMs - nudgedMs < overdueMs) continue;
    tell.push({
      kind: 'parent',
      sessionId: parent.config.id,
      child: child.config.id,
      asked,
      message: overdueParentMessage(child, anomaly, episode?.nudgedAt, input.clientName),
    });
  }
  return { tell, memory };
}
