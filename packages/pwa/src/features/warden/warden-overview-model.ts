/**
 * What the Warden page says, worked out without a browser: the status sentence, the Warden-notifications
 * link, the Watching rows and the Investigations rows. The stat tiles, layer lines and chart are in
 * `warden-stats-model.ts`; the Recent-actions rows are in `warden-action-rows-model.ts`.
 *
 * Every judgement about grouping, wording and tone lives here, where it can be proved, rather than in
 * ternaries inside JSX.
 *
 * THREE RULES CARRY THE PAGE.
 *
 *   1. JEV IS CREDITED ONLY WHAT IT RECORDED. A Jev action carries `by: 'jev'` and its confidence, so the
 *      copy says "Jev" exactly there; an investigation's verdict and a rule never read as Jev's.
 *   2. NO ALL-CLEAR OVER A BAD READ. The Warden-notifications count has its own outcomes and they never
 *      collapse: an unreadable board is `degraded`, a daemon that never swept is `no-sweep`, and a failed
 *      refresh keeps the last answer but marks it stale. Only a clean read of zero may say there are none.
 *   3. NEVER INVENT A NUMBER. A saving the daemon did not price is left out, not estimated.
 */

import type {
  FleetAttentionItem,
  WardenAction,
  WardenAnomaly,
  WardenAttentionView,
  WardenBlessingView,
  WardenFailoverAccountView,
  WardenInvestigation,
  WardenLayers,
  WardenStatusView,
  WardenVerdictKind,
} from '@ferretry/protocol';
import { displaySystemCallsign } from '@ferretry/protocol';
import type { WardenReadState } from '../../hooks/use-warden-poll.ts';
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

/** `96%`, from Jev's 0–1 confidence. */
export const percent = (confidence: number): string => `${Math.round(confidence * 100)}%`;

/** US dollars to the cent: `$0.42`. */
export const usd = (amount: number): string => `$${amount.toFixed(2)}`;

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

/**
 * The time a row shows in its narrow column: `now`, `5m`, `17h`, `2d`. The full instant belongs in the
 * row's `title`. An unreadable instant is an empty string rather than a made-up one.
 */
export const compactAgo = (at: string | undefined, now: number): string => {
  const time = Date.parse(at ?? '');
  if (!Number.isFinite(time)) return '';
  const minutes = Math.max(0, minutesBetween(time, now));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`;
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

/** What becomes of a new flag while Jev is paused, in plain words: a full check, or the owner. */
const pausedTo = (status: WardenStatusView): string =>
  status.triage.llm.active ? 'go to a full check' : 'wait for you';

/** What becomes of a flag Jev did not clear: an investigation while that layer runs, the owner otherwise. */
const passedTo = (status: WardenStatusView): string =>
  status.triage.llm.active ? 'goes to an investigation' : 'waits for you';

const guardWarning = (status: WardenStatusView, now: number): string | undefined => {
  const { jev, llm } = status.triage;
  const llmPaced = wardenPacedUntil(status, 'investigation');
  if (llm.reason === 'investigation_cap' && llmPaced !== undefined)
    return `Full checks paused until ${llmPaced} — new flags wait for you`;
  if (llm.reason === 'investigation_cap') return 'LLM cap hit — flags wait for you until midnight UTC';
  if (llm.reason === 'no_login')
    return `${wardenLoginProblem(status.login, status.failover?.accounts ?? []) ?? 'No investigation login'} — investigations are off until you choose one in Settings › Warden`;
  const jevPaced = wardenPacedUntil(status, 'jev');
  if (jev.reason === 'jev_cap' && jevPaced !== undefined)
    return `Jev paused until ${jevPaced} — new flags ${pausedTo(status)}`;
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

// ── Warden notifications ────────────────────────────────────────────────────────────────────────

/**
 * What the one quiet line about Warden notifications says. The notifications live in the Attention
 * inbox; this page only counts them, and counts honestly: a read that failed or came back incomplete is
 * a warning, never "none".
 */
export type WardenInboxLine =
  | { readonly kind: 'hidden' }
  | { readonly kind: 'link'; readonly text: string; readonly stale: boolean }
  | { readonly kind: 'none'; readonly text: string }
  | { readonly kind: 'warning'; readonly text: string };

const COULD_NOT_COUNT: WardenInboxLine = { kind: 'warning', text: 'Couldn’t count Warden notifications' };

export const wardenInboxLine = (attention: WardenReadState<WardenAttentionView>): WardenInboxLine => {
  if (attention.status === 'loading') return { kind: 'hidden' };
  if (attention.status === 'error') return COULD_NOT_COUNT;
  const { view } = attention;
  if (view.outcome === 'degraded' || view.wardenDegraded !== undefined) return COULD_NOT_COUNT;
  const count = view.items.length;
  if (count === 0)
    return attention.status === 'stale' || view.outcome === 'no-sweep'
      ? COULD_NOT_COUNT
      : { kind: 'none', text: 'No Warden notifications' };
  return {
    kind: 'link',
    text: `${count} Warden ${count === 1 ? 'notification' : 'notifications'} in Inbox`,
    stale: attention.status === 'stale',
  };
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

/** Being judged right now, so it is watched rather than waiting on the owner. */
const inFlight = (item: FleetAttentionItem): boolean =>
  item.judgement?.state === 'pending' || item.judgement?.state === 'queued';

const itemReason = (item: FleetAttentionItem): string => {
  const parts = [item.subject.trim(), item.why.trim()].filter(part => part !== '');
  return [...new Set(parts)].join(' — ') || 'No reason recorded.';
};

/** One session's row in the Watching list. The name is resolved by the view, from the session list. */
export interface WardenRow {
  readonly key: string;
  readonly sessionId: string;
  /** The names the wire carried, for a session the list no longer has. */
  readonly teammate?: string;
  readonly label?: string;
  readonly reason: string;
  readonly chips: readonly WardenChip[];
  readonly at?: string;
  /** Offer "Leave it longer": the ferret has a flag, or one was cleared. */
  readonly leave?: boolean;
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

export const optional = <K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> =>
  value === undefined ? {} : ({ [key]: value } as Record<K, V>);

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
 * The Watching rows: current flags, flags being judged right now, and sessions a blessing has cleared —
 * each with how long it stays quiet. A flagged or cleared ferret offers "Leave it longer".
 */
export const watchingRows = (
  status: WardenStatusView,
  attention: WardenAttentionView | undefined,
  now: number,
): readonly WardenRow[] => {
  const rows = new Map<string, WardenRow>();
  const blessings = new Map(status.blessings.map(blessing => [blessing.sessionId, blessing]));
  const grouped = new Map<string, WardenAnomaly[]>();
  for (const anomaly of status.anomalies)
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
    if (!inFlight(item) || rows.has(item.sessionId)) continue;
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
    if (rows.has(blessing.sessionId)) continue;
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

// ── Investigations ──────────────────────────────────────────────────────────────────────────────

const ORIGIN_TITLE: Readonly<Record<WardenInvestigation['origin'], string>> = {
  sweep: 'Flagged by the sweep',
  jev: 'Jev sent it for a closer look',
  owner: 'You asked for an investigation',
};

const STATE_ORDER: Readonly<Record<WardenInvestigation['state'], number>> = { running: 0, queued: 1, done: 2 };

/** One investigation as a compact row: who investigated, which ferret, how it ended, what it cost. */
export interface WardenInvestigationRow {
  readonly key: string;
  /** The ferret investigated; empty for a fleet-wide triage. */
  readonly sessionId?: string;
  /**
   * `warden-00002A` (`warden-00002C · Fleet triage` for a fleet-wide one); `Not started` while queued, since an
   * id is issued only when a slot frees; and the old label for one an older daemon never named.
   */
  readonly investigator: string;
  /** The investigator has a real name on the wire. */
  readonly named: boolean;
  readonly chip: WardenChip;
  /** The flag that was investigated, as a quiet chip. */
  readonly anomaly?: WardenChip;
  readonly cost?: string;
  readonly at?: string;
  readonly title: string;
  readonly reportPath?: string;
  readonly verdict?: WardenVerdictKind;
}

const investigationName = (entry: WardenInvestigation): string => {
  const fleet = entry.scope === 'fleet';
  if (entry.wardenName !== undefined) {
    const name = displaySystemCallsign(entry.wardenName);
    return fleet ? `${name} · Fleet triage` : name;
  }
  if (entry.state === 'queued') return 'Not started';
  return fleet ? 'Fleet triage' : 'Investigation';
};

/** Running first, then the queue in order, then finished ones newest first. */
export const investigationRows = (status: WardenStatusView): readonly WardenInvestigationRow[] =>
  [...status.investigations]
    .sort((left, right) => STATE_ORDER[left.state] - STATE_ORDER[right.state])
    .map(entry => {
      const named = entry.wardenName !== undefined;
      const fleet = entry.scope === 'fleet';
      const investigator = investigationName(entry);
      const who = [entry.agent, entry.model].filter(part => part !== undefined).join(' · ');
      const stateChip =
        entry.state === 'done'
          ? entry.verdict === undefined
            ? chip('done', 'pend')
            : VERDICT_CHIPS[entry.verdict]
          : investigationStateChip(status, entry);
      return {
        key: `investigation:${entry.id}`,
        ...optional('sessionId', entry.targetSession),
        investigator,
        named,
        chip: stateChip,
        ...optional('anomaly', entry.anomalyKind === undefined ? undefined : ANOMALY_CHIPS[entry.anomalyKind]),
        ...optional('cost', entry.costUsd === undefined ? undefined : usd(entry.costUsd)),
        ...optional('at', entry.finishedAt ?? entry.startedAt ?? entry.queuedAt),
        title: [fleet ? 'Fleet triage of several flags' : ORIGIN_TITLE[entry.origin], who]
          .filter(part => part !== '')
          .join(' · '),
        ...optional('reportPath', entry.reportPath),
        ...optional('verdict', entry.verdict),
      };
    });

// ── Accounts ────────────────────────────────────────────────────────────────────────────────────

/** The one-line account summary: the Warden's logins, the one in use, and any that cannot be used. */
export const accountChip = (account: WardenFailoverAccountView, inUse: string | undefined): WardenChip => {
  const label = wardenAccountLabel(account);
  if (!account.eligible) return chip(`${label} · ${account.reason ?? 'unavailable'}`, 'warn');
  return chip(account.agent === inUse ? `${label} · in use` : label, 'ok');
};

/** The whole instant for a tooltip: `2026-07-31 09:14 UTC`. An unreadable instant is returned as it came. */
export const fullTime = (at: string): string => {
  const time = Date.parse(at);
  return Number.isFinite(time) ? `${new Date(time).toISOString().slice(0, 16).replace('T', ' ')} UTC` : at;
};

/** What the report dialog needs to open one report: where it is, which ferret, and how it ended. */
export interface WardenReportTarget {
  /** The ferret the report is about; absent for a fleet-wide triage, whose report covers several. */
  readonly sessionId?: string;
  readonly reportPath: string;
  readonly at?: string;
  readonly verdict?: WardenVerdictKind;
}
