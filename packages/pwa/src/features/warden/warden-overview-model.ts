/**
 * What the Warden page says, worked out without a browser.
 *
 * The page is the Insights pattern: one status sentence, a savings line, then sessions grouped by what
 * they need from the owner — Needs you, Watching — and two histories, Investigations and Recent actions.
 * Every judgement about grouping, wording and tone lives here, where it can be proved, rather than in
 * ternaries inside JSX.
 *
 * THREE RULES CARRY THE PAGE.
 *
 *   1. JEV IS CREDITED ONLY WHAT IT RECORDED. A Jev action carries `by: 'jev'` and its confidence, so the
 *      copy says "Jev" exactly there; an investigation's verdict and a rule never read as Jev's.
 *   2. NO ALL-CLEAR OVER A BAD READ. The "who needs you" feed has four outcomes and they never collapse:
 *      an unreadable board is `degraded`, a daemon that never swept is `no-sweep`, and a failed refresh
 *      keeps the last answer but marks it stale. Only `clean-sweep` may say nobody needs you.
 *   3. NEVER INVENT A NUMBER. A saving the daemon did not price is left out, not estimated.
 */

import type {
  FleetAttentionItem,
  WardenAction,
  WardenActionKind,
  WardenAnomaly,
  WardenAttentionOutcome,
  WardenAttentionView,
  WardenBlessingView,
  WardenFailoverAccountView,
  WardenInvestigation,
  WardenJudgement,
  WardenLayers,
  WardenStatusView,
  WardenVerdictKind,
} from '@ferretry/protocol';
import {
  wardenAccountLabel,
  wardenInvestigationHead,
  wardenLoginProblem,
  wardenPacedUntil,
} from './warden-status-model.ts';
import { ANOMALY_CHIPS, chip, layersLabel, type WardenChip } from './warden-vocabulary.ts';

// ── Vocabulary ──────────────────────────────────────────────────────────────────────────────────

/** What an investigation's verdict did, as the chip on its row. */
const VERDICT_CHIPS: Readonly<Record<WardenVerdictKind, WardenChip>> = {
  killed: chip('stop', 'err'),
  revived: chip('revived', 'ok'),
  nudged: chip('nudged', 'accent'),
  cleared: chip('leave', 'ok'),
  needs_human: chip('needs you', 'warn'),
  unknown: chip('reviewed', 'pend'),
};

export const verdictChip = (verdict: WardenVerdictKind): WardenChip => VERDICT_CHIPS[verdict];

const ACTION_DONE: Readonly<Record<WardenActionKind, WardenChip>> = {
  bless: chip('blessed', 'ok'),
  nudge: chip('nudged', 'accent'),
  resume: chip('revived', 'ok'),
  restart: chip('restarted', 'ok'),
  stop: chip('stopped', 'err'),
  failover: chip('failed over', 'accent'),
  close_leftover: chip('cleaned up', 'ok'),
};

const ACTION_VERB: Readonly<Record<WardenActionKind, string>> = {
  bless: 'bless',
  nudge: 'nudge',
  resume: 'resume',
  restart: 'restart',
  stop: 'stop',
  failover: 'fail over',
  close_leftover: 'close a leftover browser',
};

/** `96%`, from Jev's 0–1 confidence. */
export const percent = (confidence: number): string => `${Math.round(confidence * 100)}%`;

/** US dollars to the cent: `$0.42`. */
export const usd = (amount: number): string => `$${amount.toFixed(2)}`;

const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

/** The chip for one recorded action: what happened, what is waiting on the owner, or what failed. */
export const actionChip = (action: WardenAction): WardenChip => {
  if (action.outcome === 'held')
    return chip(`${action.by === 'jev' ? 'Jev recommends ' : ''}${ACTION_VERB[action.action]} · asks you`, 'warn');
  if (action.outcome === 'failed') return chip(`${ACTION_VERB[action.action]} failed`, 'err');
  if (action.action === 'bless' && action.by === 'owner') return chip('left alone by you', 'accent');
  if (action.action === 'bless' && action.by === 'jev')
    return chip(
      action.confidence === undefined ? 'blessed by Jev' : `blessed by Jev ${percent(action.confidence)}`,
      'ok',
    );
  return ACTION_DONE[action.action];
};

/**
 * Who stands behind an action Jev took or recommended: `Jev · 94% sure`. A bless already says it in its own
 * chip, and an investigation's or a rule's action has no Jev to name.
 */
const jevChip = (action: WardenAction): WardenChip | undefined => {
  if (action.by !== 'jev' || action.action === 'bless') return undefined;
  return chip(action.confidence === undefined ? 'Jev' : `Jev · ${percent(action.confidence)} sure`, 'accent');
};

// ── Time ────────────────────────────────────────────────────────────────────────────────────────

const minutesBetween = (from: number, to: number): number => Math.round((to - from) / 60_000);

/** `just now`, `4 min ago`, `3 h ago`, `2 d ago` — or undefined for an unreadable instant. */
export const agoLabel = (at: string | undefined, now: number): string | undefined => {
  const time = Date.parse(at ?? '');
  if (!Number.isFinite(time)) return undefined;
  const minutes = Math.max(0, minutesBetween(time, now));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
};

/** `next in 2 min`, `next sweep due now`, or undefined when no timer is armed. */
export const nextSweepLabel = (at: string | undefined, now: number): string | undefined => {
  const time = Date.parse(at ?? '');
  if (!Number.isFinite(time)) return undefined;
  const minutes = Math.ceil((time - now) / 60_000);
  return minutes <= 0 ? 'next sweep due now' : `next in ${minutes} min`;
};

// ── Status line ─────────────────────────────────────────────────────────────────────────────────

export interface WardenStatusLine {
  /** The bold head: the triage in effect, or the Warden being off. */
  readonly lead: string;
  /** The rest of the sentence, joined by `·` on screen. */
  readonly parts: readonly string[];
  /** A fallback the owner must hear about: a cap hit, no Jev key, a failing guard. */
  readonly warning?: string;
}

/** Who runs investigations: the head of the account list, by model when one is pinned. */
export const investigatorLabel = (status: Pick<WardenStatusView, 'config' | 'failover'>): string => {
  const head = wardenInvestigationHead(status);
  return head?.model ?? (head === undefined ? 'no login' : wardenAccountLabel(head));
};

/** What becomes of a flag Jev did not clear: an investigation while that layer runs, the owner otherwise. */
const passedTo = (status: WardenStatusView): string =>
  status.triage.llm.active ? 'goes to an investigation' : 'waits for you';

const guardWarning = (status: WardenStatusView, now: number): string | undefined => {
  const { jev, llm } = status.triage;
  const llmPaced = wardenPacedUntil(status, 'investigation');
  if (llm.reason === 'investigation_cap' && llmPaced !== undefined)
    return `This hour’s share of the LLM cap is spent — flags wait until ${llmPaced}`;
  if (llm.reason === 'investigation_cap') return 'LLM cap hit — flags wait for you until midnight UTC';
  if (llm.reason === 'no_login')
    return `${wardenLoginProblem(status.login, status.failover?.accounts ?? []) ?? 'No investigation login'} — investigations are off until you choose one in Settings › Warden`;
  const jevPaced = wardenPacedUntil(status, 'jev');
  if (jev.reason === 'jev_cap' && jevPaced !== undefined)
    return `This hour’s share of the Jev cap is spent — every flag ${passedTo(status)} until ${jevPaced}`;
  if (jev.reason === 'jev_cap') return `Jev cap hit — every flag ${passedTo(status)} until midnight UTC`;
  if (!jev.configured) return undefined;
  if (status.triage.guardFailure?.code === 'not_set') return `No Jev key — every flag ${passedTo(status)}`;
  const backoff = Date.parse(status.triage.guardBackoffUntil ?? '');
  if (Number.isFinite(backoff) && backoff > now) return `Jev is busy — each flag ${passedTo(status)}`;
  if (status.triage.guardFailure !== undefined)
    return `Jev failed (${status.triage.guardFailure.code.replaceAll('_', ' ')}) — that flag ${passedTo(status)}`;
  return undefined;
};

export const wardenStatusLine = (status: WardenStatusView, now: number): WardenStatusLine => {
  if (!status.config.enabled || status.triage.jev.reason === 'disabled')
    return { lead: 'The Warden is off.', parts: ['Nothing is watched.'] };
  const { layers } = status.config;
  const parts: string[] = [];
  if (layers.jev) parts.push(`Jev clears at ≥${status.config.guard.threshold.toFixed(2)}`);
  if (layers.llm) parts.push(`${investigatorLabel(status)} investigations`);
  parts.push(`every ${status.config.intervalMinutes} min`);
  if (layers.jev || layers.llm) {
    const { spend } = status;
    const cap = (layers.jev ? spend.jevCapUsd : 0) + (layers.llm ? spend.investigationCapUsd : 0);
    parts.push(`${usd(spend.jevUsd + spend.investigationUsd)} of ${usd(cap)} today`);
  }
  const swept = agoLabel(status.lastSweepAt, now);
  parts.push(swept === undefined ? 'not swept yet' : `swept ${swept}`);
  const next = nextSweepLabel(status.nextSweepAt, now);
  if (next !== undefined) parts.push(next);
  const warning = guardWarning(status, now);
  const lead = layersLabel(layers);
  return warning === undefined ? { lead, parts } : { lead, parts, warning };
};

/** Today's flags and what became of them. Undefined while the Warden is off. */
export const wardenSavingsLine = (status: WardenStatusView): string | undefined => {
  if (!status.config.enabled || status.triage.jev.reason === 'disabled') return undefined;
  const { savings, spend } = status;
  const { layers } = status.config;
  const flags = plural(savings.flags, 'flag');
  const pending = spend.pendingInvestigations > 0 ? ` · ${spend.pendingInvestigations} pending` : '';
  const investigated = `${savings.investigations} investigated (${usd(spend.investigationUsd)})${pending}`;
  const cleared = `${savings.jevSkips} cleared by Jev (${usd(spend.jevUsd)})`;
  const handled = savings.jevActions === undefined ? '' : ` · Jev handled ${savings.jevActions} itself`;
  if (!layers.jev && !layers.llm) return `Today: ${flags} shown to you · no AI · $0.00`;
  if (!layers.jev) return `Today: ${flags} · ${investigated}`;
  if (!layers.llm) return `Today: ${flags} · ${cleared}${handled} · the rest shown to you`;
  const saved = savings.savedUsd === undefined ? '' : ` · ~${usd(savings.savedUsd)} saved vs investigating all`;
  return `Today: ${flags} · ${cleared}${handled} · ${investigated}${saved}`;
};

export const wardenHowItWorks = (layers: WardenLayers): string => {
  if (!layers.jev && !layers.llm)
    return 'How it works: free rules flag anomalies and show them to you. No AI runs and nothing is spent.';
  const jev = layers.jev
    ? ` Jev clears a flag it is sure is healthy, and does a simple fix itself when it is very sure; anything else ${layers.llm ? 'goes on' : 'is shown to you'}.`
    : '';
  const llm = layers.llm
    ? ' A read-only investigation decides leave, nudge, resume, stop or needs you. Stopping asks you unless you allowed it.'
    : ' No investigation runs.';
  return `How it works: free rules flag anomalies.${jev}${llm}`;
};

// ── Who needs you ───────────────────────────────────────────────────────────────────────────────

/** What the Needs-you group says when it has no rows. Only a clean sweep is an all-clear. */
export const needsYouEmpty = (outcome: WardenAttentionOutcome, stale: boolean): string => {
  if (stale) return 'Nobody was waiting at the last check, but that check is stale. Not an all-clear.';
  if (outcome === 'clean-sweep') return 'Nothing is waiting on you right now.';
  if (outcome === 'degraded') return 'The check is incomplete, so this is not an all-clear.';
  return 'No sweep has run yet, so nobody has been checked.';
};

/** The Warden's judgement as a chip, when it made one worth showing. */
const judgementChip = (judgement: WardenJudgement | undefined): WardenChip | undefined => {
  if (judgement === undefined) return undefined;
  if (judgement.state === 'failed') return chip('Warden failed', 'err');
  if (judgement.state !== 'judged' || judgement.verdict === undefined) return undefined;
  const verdict = VERDICT_CHIPS[judgement.verdict];
  return chip(`Warden: ${verdict.label}`, verdict.tone);
};

const SOURCE_CHIPS: Readonly<Record<Exclude<FleetAttentionItem['source'], 'warden-anomaly'>, WardenChip>> = {
  task: chip('task', 'pend'),
  question: chip('question', 'warn'),
  'agent-raised': chip('asks for you', 'warn'),
  'warden-action': chip('asks you', 'warn'),
};

const sourceChip = (item: FleetAttentionItem): WardenChip =>
  item.source === 'warden-anomaly'
    ? item.anomalyKind === undefined
      ? chip('flagged', 'warn')
      : ANOMALY_CHIPS[item.anomalyKind]
    : SOURCE_CHIPS[item.source];

/** Nobody has judged this flag yet: the owner may send it to an investigation. */
export const canInvestigate = (item: FleetAttentionItem): boolean =>
  item.source === 'warden-anomaly' &&
  (item.judgement === undefined || item.judgement.state === 'none' || item.judgement.state === 'failed');

/** Being judged right now, so it is watched rather than waiting on the owner. */
const inFlight = (item: FleetAttentionItem): boolean =>
  item.judgement?.state === 'pending' || item.judgement?.state === 'queued';

const itemReason = (item: FleetAttentionItem): string => {
  const parts = [item.subject.trim(), item.why.trim()].filter(part => part !== '');
  return [...new Set(parts)].join(' — ') || 'No reason recorded.';
};

const provenance = (judgement: WardenJudgement | undefined): string | undefined => {
  const by = judgement?.judgedBy;
  if (judgement?.state !== 'judged' || by === undefined) return undefined;
  const who = [by.agent, by.model].filter(part => part !== undefined && part !== '').join(' · ');
  return who === '' ? undefined : `Judged by ${who}`;
};

/** One session's row in a group. The name is resolved by the view, from the session list. */
export interface WardenRow {
  readonly key: string;
  readonly sessionId: string;
  /** The names the wire carried, for a session the list no longer has. */
  readonly teammate?: string;
  readonly label?: string;
  readonly reason: string;
  /** A second, quieter line: who judged it, which model, what it cost. */
  readonly detail?: string;
  readonly chips: readonly WardenChip[];
  readonly at?: string;
  /** Offer "Investigate": an unjudged flag. */
  readonly investigate?: boolean;
  /** Offer "Leave it longer": the ferret has a flag, or one was cleared. */
  readonly leave?: boolean;
  /** Offer "Report": a finished investigation's evidence. */
  readonly reportPath?: string;
  readonly verdict?: WardenVerdictKind;
}

const dedupeChips = (chips: readonly (WardenChip | undefined)[]): WardenChip[] => {
  const seen = new Map<string, WardenChip>();
  for (const entry of chips) if (entry !== undefined && !seen.has(entry.label)) seen.set(entry.label, entry);
  return [...seen.values()];
};

const timestamp = (at: string | undefined): number => {
  const parsed = Date.parse(at ?? '');
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
};

const optional = <K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> =>
  value === undefined ? {} : ({ [key]: value } as Record<K, V>);

/**
 * The Needs-you rows: one per session, oldest wait first. A session with several items keeps its oldest
 * one's reason and gathers every chip, so it appears once.
 */
export const needsYouRows = (view: WardenAttentionView): readonly WardenRow[] => {
  const bySession = new Map<string, FleetAttentionItem[]>();
  const items = view.items
    .filter(item => !inFlight(item))
    .sort((left, right) => timestamp(left.waitingSince) - timestamp(right.waitingSince));
  for (const item of items) bySession.set(item.sessionId, [...(bySession.get(item.sessionId) ?? []), item]);
  return [...bySession.entries()].map(([sessionId, group]) => {
    const [first, ...rest] = group as [FleetAttentionItem, ...FleetAttentionItem[]];
    const judged = group.find(item => item.judgement?.reportPath !== undefined)?.judgement;
    return {
      key: `needs:${sessionId}`,
      sessionId,
      ...optional('teammate', first.teammate),
      ...optional('label', first.label),
      reason: itemReason(first),
      ...optional('detail', provenance(first.judgement)),
      chips: dedupeChips([
        ...group.map(sourceChip),
        ...group.map(item => judgementChip(item.judgement)),
        rest.length > 0 ? chip(`+${plural(rest.length, 'more reason')}`, 'pend') : undefined,
      ]),
      at: first.waitingSince,
      ...(group.some(canInvestigate) ? { investigate: true } : {}),
      ...(group.some(item => item.source === 'warden-anomaly') ? { leave: true } : {}),
      ...optional('reportPath', judged?.reportPath),
    };
  });
};

// ── Watching ────────────────────────────────────────────────────────────────────────────────────

const investigationFor = (status: WardenStatusView, sessionId: string): WardenInvestigation | undefined =>
  status.investigations.find(entry => entry.targetSession === sessionId && entry.state !== 'done');

/** `1` is next. Queued investigations wait in the order they were queued. */
export const queuePosition = (status: WardenStatusView, investigation: WardenInvestigation): number =>
  status.investigations
    .filter(entry => entry.state === 'queued')
    .sort((left, right) => timestamp(left.queuedAt) - timestamp(right.queuedAt))
    .indexOf(investigation) + 1;

const investigationStateChip = (status: WardenStatusView, entry: WardenInvestigation): WardenChip =>
  entry.state === 'running'
    ? chip('investigating', 'accent', true)
    : chip(`queued #${queuePosition(status, entry)}`, 'pend');

/** The latest blessing action for a session, which carries Jev's confidence. */
const latestBless = (status: WardenStatusView, sessionId: string): WardenAction | undefined =>
  status.actions.find(entry => entry.sessionId === sessionId && entry.action === 'bless' && entry.outcome === 'done');

const clearedChip = (status: WardenStatusView, sessionId: string): WardenChip => {
  const bless = latestBless(status, sessionId);
  if (bless?.by === 'owner') return chip('left alone by you', 'accent');
  return chip(
    bless?.by === 'jev' && bless.confidence !== undefined ? `cleared · Jev ${percent(bless.confidence)}` : 'cleared',
    'ok',
  );
};

/** `45 min`, `2 h`, `1 h 20 min`. */
export const durationLabel = (ms: number): string => {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
};

/**
 * How much longer a cleared ferret is left alone, as a chip — `quiet 45 min`, `quiet until it changes` —
 * with the run of clears that made it long: `×3` is the third clear in a row.
 */
export const cooldownChip = (blessing: WardenBlessingView, now: number): WardenChip => {
  if (blessing.untilChange === true) return chip('quiet until it changes', 'ok');
  const left = durationLabel(Date.parse(blessing.expiresAt) - now);
  return chip(blessing.streak === undefined ? `quiet ${left}` : `quiet ${left} · ×${blessing.streak + 1}`, 'ok');
};

/**
 * The Watching rows: current flags nobody needs the owner for yet, flags being judged right now, and
 * sessions a blessing has cleared — each with how long it stays quiet. A session already in Needs you
 * is never repeated here. A flagged or cleared ferret offers "Leave it longer".
 */
export const watchingRows = (
  status: WardenStatusView,
  attention: WardenAttentionView | undefined,
  exclude: ReadonlySet<string>,
  now: number,
): readonly WardenRow[] => {
  const rows = new Map<string, WardenRow>();
  const blessings = new Map(status.blessings.map(blessing => [blessing.sessionId, blessing]));
  const grouped = new Map<string, WardenAnomaly[]>();
  for (const anomaly of status.anomalies)
    if (!exclude.has(anomaly.sessionId))
      grouped.set(anomaly.sessionId, [...(grouped.get(anomaly.sessionId) ?? []), anomaly]);
  for (const [sessionId, group] of grouped) {
    const [first] = group as [WardenAnomaly, ...WardenAnomaly[]];
    const running = investigationFor(status, sessionId);
    const blessing = blessings.get(sessionId);
    rows.set(sessionId, {
      key: `watch:${sessionId}`,
      sessionId,
      ...optional('teammate', first.teammate),
      ...optional('label', first.label),
      reason: first.detail,
      chips: dedupeChips([
        ...group.map(anomaly => ANOMALY_CHIPS[anomaly.kind]),
        running === undefined ? undefined : investigationStateChip(status, running),
        blessing === undefined ? undefined : clearedChip(status, sessionId),
        blessing === undefined ? undefined : cooldownChip(blessing, now),
      ]),
      ...optional('at', first.since),
      leave: true,
    });
  }
  for (const item of attention?.items ?? []) {
    if (!inFlight(item) || exclude.has(item.sessionId) || rows.has(item.sessionId)) continue;
    rows.set(item.sessionId, {
      key: `watch:${item.sessionId}`,
      sessionId: item.sessionId,
      ...optional('teammate', item.teammate),
      ...optional('label', item.label),
      reason: itemReason(item),
      chips: dedupeChips([
        sourceChip(item),
        item.judgement?.state === 'pending' ? chip('investigating', 'accent', true) : chip('queued', 'pend'),
      ]),
      at: item.waitingSince,
    });
  }
  for (const blessing of status.blessings) {
    if (exclude.has(blessing.sessionId) || rows.has(blessing.sessionId)) continue;
    const bless = latestBless(status, blessing.sessionId);
    rows.set(blessing.sessionId, {
      key: `watch:${blessing.sessionId}`,
      sessionId: blessing.sessionId,
      reason: bless?.detail ?? 'Judged healthy, so these flags are not raised again for a while.',
      chips: dedupeChips([
        ...blessing.kinds.map(kind => ANOMALY_CHIPS[kind]),
        clearedChip(status, blessing.sessionId),
        cooldownChip(blessing, now),
      ]),
      ...optional('at', bless?.at),
      leave: true,
    });
  }
  return [...rows.values()];
};

// ── Histories ───────────────────────────────────────────────────────────────────────────────────

const ORIGIN_REASON: Readonly<Record<WardenInvestigation['origin'], string>> = {
  sweep: 'Flagged by the sweep',
  jev: 'Jev sent it for a closer look',
  owner: 'You asked for an investigation',
};

const STATE_ORDER: Readonly<Record<WardenInvestigation['state'], number>> = { running: 0, queued: 1, done: 2 };

/** Running first, then the queue in order, then finished ones newest first. */
export const investigationRows = (status: WardenStatusView): readonly WardenRow[] =>
  [...status.investigations]
    .sort((left, right) => STATE_ORDER[left.state] - STATE_ORDER[right.state])
    .map(entry => {
      const kind = entry.anomalyKind === undefined ? '' : `: ${ANOMALY_CHIPS[entry.anomalyKind].label}`;
      const who = [entry.agent, entry.model, entry.costUsd === undefined ? undefined : usd(entry.costUsd)]
        .filter(part => part !== undefined)
        .join(' · ');
      const stateChip =
        entry.state === 'done'
          ? entry.verdict === undefined
            ? chip('done', 'pend')
            : VERDICT_CHIPS[entry.verdict]
          : investigationStateChip(status, entry);
      return {
        key: `investigation:${entry.id}`,
        sessionId: entry.targetSession ?? entry.wardenSession ?? entry.id,
        reason:
          entry.scope === 'fleet' ? `Fleet triage of several flags${kind}` : `${ORIGIN_REASON[entry.origin]}${kind}`,
        ...optional('detail', who === '' ? undefined : who),
        chips: [stateChip],
        ...optional('at', entry.finishedAt ?? entry.startedAt ?? entry.queuedAt),
        ...optional('reportPath', entry.reportPath),
        ...optional('verdict', entry.verdict),
      };
    });

/** How many recent actions the page lists. Older ones are in the reports. */
export const RECENT_ACTIONS_SHOWN = 12;

export const actionRows = (status: WardenStatusView): readonly WardenRow[] =>
  status.actions.slice(0, RECENT_ACTIONS_SHOWN).map((entry, index) => ({
    key: `action:${entry.at}:${entry.sessionId}:${index}`,
    sessionId: entry.sessionId,
    reason: entry.detail,
    ...optional('detail', entry.reason === undefined ? undefined : `Jev’s reason: ${entry.reason}`),
    chips: dedupeChips([
      actionChip(entry),
      jevChip(entry),
      entry.anomalyKind === undefined ? undefined : ANOMALY_CHIPS[entry.anomalyKind],
      entry.action === 'failover' && entry.agent !== undefined ? chip(`→ ${entry.agent}`, 'pend') : undefined,
    ]),
    at: entry.at,
    ...optional('reportPath', entry.reportPath),
  }));

// ── Accounts ────────────────────────────────────────────────────────────────────────────────────

/** The one-line account summary: the Warden's logins, the one in use, and any that cannot be used. */
export const accountChip = (account: WardenFailoverAccountView, inUse: string | undefined): WardenChip => {
  const label = wardenAccountLabel(account);
  if (!account.eligible) return chip(`${label} · ${account.reason ?? 'unavailable'}`, 'warn');
  return chip(account.agent === inUse ? `${label} · in use` : label, 'ok');
};
