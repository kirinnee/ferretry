/**
 * Recent triggers as rows: ONE ROW PER TRIGGER, filtered and paged. Pure — the tsx only draws.
 *
 * A TRIGGER is one flag on one ferret (or one rule firing, such as a usage limit) plus everything that
 * followed for it: Jev's check, the investigation Jev handed it to, and the final act. The Warden keeps
 * those as three kinds of record (`status.jevChecks`, `status.investigations`, `status.actions`); this
 * module joins them back into the one story the owner reads, so a flag Jev passed on and an LLM settled
 * is ONE row, not three.
 *
 * THE JOIN READS THE LINKS THE DAEMON ALREADY WRITES — nothing is guessed while a link exists:
 *   1. An action carries its investigation's `reportPath` and `investigator`; an investigation carries the
 *      Jev check it followed (`jev.at`, which with the ferret and the flag names that check's line).
 *   2. A Jev act is written in the same sweep as its check: same ferret, same flag, seconds apart.
 *   3. A record from a daemon that kept none of those links joins by ferret and a time window instead, and
 *      never to a record that names a different report.
 *
 * Two rules the rows keep:
 *   - A REPEAT IS CONSECUTIVE AND TOTAL. Triggers fold into `×N` only when every column matches and
 *     nothing else sits between them: the gap is itself news.
 *   - THE RUNTIME IS THE INVESTIGATION'S OWN, from the login and model it recorded — never today's
 *     settings — and only when an LLM ran.
 */

import type {
  WardenAction,
  WardenActionKind,
  WardenInvestigation,
  WardenJevBefore,
  WardenJevCheck,
  WardenJevCheckWhy,
  WardenStatusView,
  WardenVerdictKind,
} from '@ferretry/protocol';
import { displaySystemCallsign, wardenActionActor } from '@ferretry/protocol';
import { jevBeforeLine, jevCost } from './warden-jev-line.ts';
import { agoLabel, compactAgo, fullTime, optional, percent } from './warden-overview-model.ts';
import { ANOMALY_CHIPS, chip, type WardenChip } from './warden-vocabulary.ts';

export const TRIGGERS_PAGE = 20;

/** A Jev check and the act it made are written in the same sweep. */
const SAME_SWEEP_MS = 2 * 60_000;
/** The fallback window for records that name no link: a check, an investigation and its act follow within hours. */
const LINK_WINDOW_MS = 2 * 60 * 60_000;

// ── Vocabulary ──────────────────────────────────────────────────────────────────────────────────

/** Who handled a trigger. `owner` is the owner leaving a flagged ferret longer. */
type TriggerWho = 'rule' | 'jev' | 'jev_llm' | 'llm' | 'owner';

const WHO_LABEL: Readonly<Record<TriggerWho, string>> = {
  rule: 'Rule',
  jev: 'Jev',
  jev_llm: 'Jev → LLM',
  llm: 'LLM',
  owner: 'You',
};

type ResultKey =
  | 'left'
  | 'nudged'
  | 'resumed'
  | 'restarted'
  | 'moved'
  | 'stopped'
  | 'asked'
  | 'held'
  | 'failed'
  | 'closed'
  | 'working'
  | 'handed'
  | 'skipped'
  | 'reviewed';

export type WhoFilter = 'all' | Exclude<TriggerWho, 'owner'>;
export type ResultFilter = 'all' | ResultKey;

export interface TriggerFilters {
  readonly who: WhoFilter;
  readonly result: ResultFilter;
}

export const NO_FILTERS: TriggerFilters = { who: 'all', result: 'all' };

export const WHO_FILTERS: readonly { readonly key: WhoFilter; readonly label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'rule', label: WHO_LABEL.rule },
  { key: 'jev', label: WHO_LABEL.jev },
  { key: 'jev_llm', label: WHO_LABEL.jev_llm },
  { key: 'llm', label: WHO_LABEL.llm },
];

const RESULTS: Readonly<Record<ResultKey, WardenChip>> = {
  left: chip('Left alone', 'pend'),
  nudged: chip('Nudged', 'ok'),
  resumed: chip('Resumed', 'ok'),
  restarted: chip('Restarted', 'ok'),
  moved: chip('Moved login', 'ok'),
  stopped: chip('Stopped', 'err'),
  asked: chip('Asked you', 'warn'),
  held: chip('Held', 'warn'),
  failed: chip('Failed', 'err'),
  closed: chip('Closed browser', 'pend'),
  working: chip('Investigating', 'accent'),
  handed: chip('Handed to LLM', 'accent'),
  skipped: chip('Skipped', 'pend'),
  reviewed: chip('Reviewed', 'pend'),
};

const RESULT_ORDER = Object.keys(RESULTS) as readonly ResultKey[];

/** What an act of each kind comes to. A `revive` keeps its own word. */
const ACT_RESULT: Readonly<Record<WardenActionKind, { readonly key: ResultKey; readonly label?: string }>> = {
  bless: { key: 'left' },
  nudge: { key: 'nudged' },
  resume: { key: 'resumed' },
  revive: { key: 'resumed', label: 'Revived' },
  restart: { key: 'restarted' },
  stop: { key: 'stopped' },
  failover: { key: 'moved' },
  close_leftover: { key: 'closed' },
};

/** What an investigation's verdict came to, when it kept no act of its own. */
const VERDICT_RESULT: Readonly<Record<WardenVerdictKind, { readonly key: ResultKey; readonly label?: string }>> = {
  cleared: { key: 'left' },
  needs_human: { key: 'asked' },
  killed: { key: 'stopped' },
  nudged: { key: 'nudged' },
  revived: { key: 'resumed', label: 'Revived' },
  unknown: { key: 'reviewed' },
};

/** What a rule saw, for the acts no model was asked about and that record no flag of their own. */
const RULE_FLAGS: Partial<Record<WardenActionKind, WardenChip>> = {
  failover: chip('usage limit', 'warn'),
  revive: chip('ferret died', 'err'),
  close_leftover: chip('leftover browser', 'pend'),
};

const UNKNOWN_FLAG = chip('flagged', 'pend');

// ── The row ─────────────────────────────────────────────────────────────────────────────────────

interface TriggerResult {
  readonly key: ResultKey;
  /** `Nudged`, `Moved login a → b`, `Held`, `Failed`. */
  readonly label: string;
  readonly tone: WardenChip['tone'];
  /** The reason, for a result that has one: held, failed, asked. */
  readonly note?: string;
  /** Something is running now. */
  readonly busy?: boolean;
}

export interface TriggerStep {
  readonly key: string;
  readonly kind: 'flag' | 'jev' | 'llm' | 'act';
  readonly label: string;
  readonly detail?: string;
  /** What Jev's check cost, `$0.0004`. */
  readonly cost?: string;
  readonly time?: string;
  /** Present on the LLM step when the investigation wrote a report. */
  readonly reportPath?: string;
}

interface TriggerTime {
  readonly compact: string;
  readonly ago: string;
  readonly full: string;
}

export interface TriggerRow {
  readonly key: string;
  readonly sessionId: string;
  /** Newest first. The first is the row's own time. */
  readonly times: readonly TriggerTime[];
  readonly flag: WardenChip;
  readonly who: TriggerWho;
  readonly whoLabel: string;
  /** The investigation's login and model, `claude-default · sonnet`. Only when an LLM ran. */
  readonly runtime?: string;
  readonly result: TriggerResult;
  /** How many identical triggers this row stands for. */
  readonly count: number;
  readonly timeline: readonly TriggerStep[];
  /** The report to open, when an investigation wrote one. */
  readonly reportPath?: string;
  /** What Jev did before the investigation, as its line, for the report dialog. */
  readonly jev?: string;
}

// ── The join ────────────────────────────────────────────────────────────────────────────────────

interface Group {
  readonly sessionId: string;
  readonly check?: WardenJevCheck;
  readonly investigation?: WardenInvestigation;
  readonly actions: readonly WardenAction[];
}

const ms = (at: string): number => Date.parse(at);

const isLlmAct = (action: WardenAction): boolean => wardenActionActor(action) === 'llm';

const passedOn = (check: WardenJevCheck): boolean => check.verdict === 'handed_on' || check.verdict === 'skipped';

/** When an investigation began, as far as its record says. */
const stampOf = (entry: WardenInvestigation): string =>
  entry.startedAt ?? entry.queuedAt ?? (entry.finishedAt as string);

const sameFlag = (check: WardenJevCheck, kind: WardenJevCheck['anomalyKind'] | undefined): boolean =>
  kind === undefined || check.anomalyKind === kind;

/** `jev.at`, with the ferret and the flag, names a check's line. */
const namedBy = (jev: WardenJevBefore | undefined, check: WardenJevCheck): boolean =>
  jev?.at !== undefined && ms(jev.at) === ms(check.at);

/** An act carries out this investigation's verdict, by the report or the investigator it names. */
const carriesOut = (entry: WardenInvestigation, action: WardenAction): boolean =>
  isLlmAct(action) &&
  action.sessionId === entry.targetSession &&
  ((entry.reportPath !== undefined && action.reportPath === entry.reportPath) ||
    (entry.wardenName !== undefined &&
      action.investigator !== undefined &&
      displaySystemCallsign(action.investigator) === displaySystemCallsign(entry.wardenName)));

/** The fallback: an LLM act on the investigation's ferret within a window of it, and no other report named. */
const follows = (entry: WardenInvestigation, action: WardenAction): boolean => {
  const rival = entry.reportPath !== undefined && action.reportPath !== undefined;
  const gap = ms(action.at) - ms(stampOf(entry));
  return isLlmAct(action) && !rival && action.sessionId === entry.targetSession && gap >= 0 && gap <= LINK_WINDOW_MS;
};

/** An act of Jev's own settles this check: the same sweep, the same ferret, the same flag. */
const settles = (check: WardenJevCheck, action: WardenAction): boolean =>
  wardenActionActor(action) === 'jev' &&
  action.sessionId === check.sessionId &&
  sameFlag(check, action.anomalyKind) &&
  Math.abs(ms(action.at) - ms(check.at)) <= SAME_SWEEP_MS;

const joinRecords = (status: WardenStatusView): readonly Group[] => {
  const checks = status.jevChecks ?? [];
  const actions = status.actions;
  const investigations = status.investigations.filter(
    (entry): entry is WardenInvestigation & { readonly targetSession: string } =>
      entry.scope === 'session' && entry.targetSession !== undefined,
  );
  const usedChecks = new Set<WardenJevCheck>();
  const usedActions = new Set<WardenAction>();
  const groups: Group[] = [];

  // 1. Each investigation takes the acts that carried out its verdict, then the check it followed.
  const taken = (match: (action: WardenAction) => boolean): WardenAction[] => {
    const found = actions.filter(action => !usedActions.has(action) && match(action));
    for (const action of found) usedActions.add(action);
    return found;
  };
  const named = investigations.map(entry => taken(action => carriesOut(entry, action)));
  // The check an investigation followed: the one it names, else the nearest passed-on check before it.
  const followed = new Map<WardenInvestigation, WardenJevCheck>();
  const claim = (entry: WardenInvestigation, check: WardenJevCheck | undefined) => {
    if (check === undefined) return;
    followed.set(entry, check);
    usedChecks.add(check);
  };
  for (const entry of investigations)
    claim(
      entry,
      checks.find(
        check =>
          !usedChecks.has(check) &&
          check.sessionId === entry.targetSession &&
          sameFlag(check, entry.anomalyKind) &&
          namedBy(entry.jev, check),
      ),
    );
  for (const entry of investigations)
    if (!followed.has(entry))
      claim(
        entry,
        checks
          .filter(
            check =>
              !usedChecks.has(check) &&
              passedOn(check) &&
              check.sessionId === entry.targetSession &&
              sameFlag(check, entry.anomalyKind) &&
              ms(stampOf(entry)) - ms(check.at) >= 0 &&
              ms(stampOf(entry)) - ms(check.at) <= LINK_WINDOW_MS,
          )
          .sort((left, right) => ms(right.at) - ms(left.at))[0],
      );
  investigations.forEach((entry, index) => {
    const own = [...(named[index] ?? []), ...taken(action => follows(entry, action))];
    const check = followed.get(entry);
    groups.push({
      sessionId: entry.targetSession,
      investigation: entry,
      ...optional('check', check),
      actions: own.sort((left, right) => ms(left.at) - ms(right.at)),
    });
  });

  // 2. An act an investigation left behind still names the check before it.
  for (const action of actions) {
    const check = usedActions.has(action)
      ? undefined
      : checks.find(
          candidate =>
            !usedChecks.has(candidate) &&
            candidate.sessionId === action.sessionId &&
            sameFlag(candidate, action.anomalyKind) &&
            namedBy(action.jev, candidate),
        );
    if (check === undefined) continue;
    usedChecks.add(check);
    usedActions.add(action);
    groups.push({ sessionId: action.sessionId, check, actions: [action] });
  }

  // 3. A check nothing took is a trigger of its own, with the act Jev made in that sweep.
  for (const check of checks) {
    if (usedChecks.has(check)) continue;
    const own = actions.filter(action => !usedActions.has(action) && settles(check, action));
    for (const action of own) usedActions.add(action);
    groups.push({ sessionId: check.sessionId, check, actions: own });
  }

  // 4. Every act left is a trigger of its own.
  for (const action of actions)
    if (!usedActions.has(action)) groups.push({ sessionId: action.sessionId, actions: [action] });
  return groups;
};

// ── One trigger ─────────────────────────────────────────────────────────────────────────────────

type JevAct = NonNullable<WardenJevCheck['act']>;

const ACT_VERB: Readonly<Record<JevAct, string>> = {
  nudge: 'nudge it',
  resume: 'resume it',
  restart: 'restart it',
  stop: 'stop it',
  failover: 'move it to another AI login',
};

const ACT_ALONE: Readonly<Record<JevAct, string>> = {
  nudge: 'nudging',
  resume: 'resuming',
  restart: 'restarting',
  stop: 'stopping',
  failover: 'moving accounts',
};

/** What Jev made of the flag, in a sentence that ends before where it went. */
const checkCause = (check: WardenJevCheck): string => {
  const sure = percent(check.confidence);
  const act = check.act === undefined ? undefined : ACT_VERB[check.act];
  const why: WardenJevCheckWhy | undefined = check.why;
  switch (why) {
    case 'jev_cap':
      return 'Jev was not asked: its daily cap is spent';
    case 'jev_paced':
      return 'Jev was not asked: this hour’s share of its cap is spent';
    case 'failed':
      return 'Jev’s check failed';
    case 'act_failed':
      return `Jev tried to ${act ?? 'act'} (${sure} sure) and it did not take`;
    case 'never_alone':
    case 'not_allowed':
      return check.act === undefined
        ? `Jev was ${sure} sure, but may not act alone`
        : `Jev would ${ACT_VERB[check.act]} (${sure} sure), but ${ACT_ALONE[check.act]} alone is off`;
    case 'cannot_choose_login':
      return `Jev would move it to another AI login (${sure} sure), but cannot choose which`;
    case 'not_sure_enough':
      return `Jev was only ${sure} sure${act === undefined ? '' : ` it should ${act}`}, below your bar`;
    case 'no_message':
      return 'Jev would nudge it, but was not sure enough of what to say';
    case 'already_acted':
      return 'Jev already acted on this and it is still flagged';
    case 'not_offered':
      return 'Jev chose something this flag does not allow';
    case 'unsure':
    case undefined:
      return `Jev was not sure (${sure})`;
  }
};

/** Jev's check in one sentence, ending with where it went. */
const checkSentence = (check: WardenJevCheck): string => {
  switch (check.verdict) {
    case 'healthy':
      return `Jev was ${percent(check.confidence)} sure it is healthy, so the flag was left.`;
    case 'acted':
      return `Jev was ${percent(check.confidence)} sure and acted${check.act === undefined ? '' : `: ${ACT_VERB[check.act]}`}.`;
    case 'handed_on':
    case 'skipped':
      return `${checkCause(check)}, so ${check.route === 'owner' ? 'it waits for you' : 'it went to an investigation'}.`;
  }
};

const runtimeOf = (entry: WardenInvestigation): string | undefined =>
  entry.agent === undefined ? undefined : entry.model === undefined ? entry.agent : `${entry.agent} · ${entry.model}`;

const resultOf = (kind: { readonly key: ResultKey; readonly label?: string }): TriggerResult => ({
  key: kind.key,
  label: kind.label ?? RESULTS[kind.key].label,
  tone: RESULTS[kind.key].tone,
});

const actResult = (action: WardenAction): TriggerResult => {
  if (action.outcome === 'failed') return { ...resultOf({ key: 'failed' }), note: action.detail };
  if (action.outcome === 'held') return { ...resultOf({ key: 'held' }), note: action.detail };
  const result = resultOf(ACT_RESULT[action.action]);
  return action.action === 'failover' && action.agent !== undefined
    ? {
        ...result,
        label: `${result.label} ${action.fromAgent === undefined ? '' : `${action.fromAgent} `}→ ${action.agent}`,
      }
    : result;
};

const investigationResult = (entry: WardenInvestigation): TriggerResult => {
  if (entry.state === 'queued') return resultOf({ key: 'working', label: 'Queued' });
  if (entry.state === 'running') return { ...resultOf({ key: 'working' }), busy: true };
  return resultOf(VERDICT_RESULT[entry.verdict ?? 'unknown']);
};

/** A skip says which limit stopped Jev, since no investigation followed to carry the flag on. */
const skipLabel = (why: WardenJevCheckWhy | undefined): string =>
  why === 'jev_cap' ? 'Skipped: daily cap' : why === 'jev_paced' ? 'Skipped: hourly share' : 'Skipped';

/** A check no investigation followed. `Handed to LLM` is only right while one may still come. */
const checkResult = (check: WardenJevCheck): TriggerResult => {
  if (check.verdict === 'healthy') return resultOf({ key: 'left' });
  if (check.verdict === 'acted') return resultOf(check.act === undefined ? { key: 'reviewed' } : ACT_RESULT[check.act]);
  return check.route === 'owner'
    ? { ...resultOf({ key: 'asked' }), note: checkCause(check) }
    : check.verdict === 'skipped'
      ? resultOf({ key: 'skipped', label: skipLabel(check.why) })
      : resultOf({ key: 'handed' });
};

const groupResult = (group: Group): TriggerResult => {
  const last = group.actions[group.actions.length - 1];
  if (last !== undefined) return actResult(last);
  if (group.investigation !== undefined) return investigationResult(group.investigation);
  return checkResult(group.check as WardenJevCheck);
};

const flagOf = (group: Group): WardenChip => {
  const kind =
    group.check?.anomalyKind ??
    group.investigation?.anomalyKind ??
    group.actions.find(action => action.anomalyKind !== undefined)?.anomalyKind;
  if (kind !== undefined) return ANOMALY_CHIPS[kind];
  return RULE_FLAGS[group.actions[0]?.action ?? 'bless'] ?? UNKNOWN_FLAG;
};

/** What Jev recorded before an LLM took over, from the investigation or from the act that carried it out. */
const jevBeforeOf = (group: Group): WardenJevBefore | undefined =>
  group.investigation?.jev ?? group.actions.find(action => action.jev !== undefined)?.jev;

const whoOf = (group: Group): TriggerWho => {
  if (group.investigation !== undefined || group.actions.some(isLlmAct)) {
    const before = jevBeforeOf(group);
    return group.check !== undefined || before?.verdict === 'handed_on' || before?.verdict === 'skipped'
      ? 'jev_llm'
      : 'llm';
  }
  if (group.check !== undefined) return 'jev';
  const actor = wardenActionActor(group.actions[0] as WardenAction);
  return actor === 'jev' ? 'jev' : actor === 'owner' ? 'owner' : 'rule';
};

const startedAtOf = (group: Group): string =>
  [group.check?.at, group.investigation === undefined ? undefined : stampOf(group.investigation), group.actions[0]?.at]
    .filter((at): at is string => at !== undefined)
    .sort((left, right) => ms(left) - ms(right))[0] as string;

const timelineOf = (
  group: Group,
  flag: WardenChip,
  runtime: string | undefined,
  startedAt: string,
  reportPath: string | undefined,
): readonly TriggerStep[] => {
  const steps: TriggerStep[] = [
    { key: 'flag', kind: 'flag', label: `Flagged: ${flag.label}`, time: fullTime(startedAt) },
  ];
  const before = jevBeforeOf(group);
  const { check, investigation } = group;
  if (check !== undefined)
    steps.push({
      key: 'jev',
      kind: 'jev',
      label: 'Jev checked it',
      detail: checkSentence(check),
      ...(check.verdict === 'skipped' ? {} : { cost: jevCost(check.costUsd) }),
      time: fullTime(check.at),
    });
  else if (before !== undefined)
    steps.push({
      key: 'jev',
      kind: 'jev',
      label: 'Jev checked it',
      detail: jevBeforeLine(before),
      ...(before.costUsd === undefined || before.costUsd === 0 ? {} : { cost: jevCost(before.costUsd) }),
      ...(before.at === undefined ? {} : { time: fullTime(before.at) }),
    });
  const llmAct = group.actions.find(isLlmAct);
  if (investigation !== undefined || llmAct !== undefined) {
    const investigator = investigation?.wardenName ?? llmAct?.investigator;
    const detail = [runtime, investigation?.state === 'done' ? undefined : investigation?.state]
      .filter((part): part is string => part !== undefined)
      .join(' · ');
    steps.push({
      key: 'llm',
      kind: 'llm',
      label: investigator === undefined ? 'Investigated' : `Investigated by ${displaySystemCallsign(investigator)}`,
      ...(detail === '' ? {} : { detail }),
      time: fullTime(investigation?.finishedAt ?? investigation?.startedAt ?? llmAct?.at ?? startedAt),
      ...optional('reportPath', reportPath),
    });
  }
  for (const action of group.actions)
    steps.push({
      key: `act:${action.action}:${action.at}`,
      kind: 'act',
      label: actResult(action).label,
      detail: action.detail,
      time: fullTime(action.at),
    });
  return steps;
};

const rowOf = (group: Group, now: number): TriggerRow => {
  const startedAt = startedAtOf(group);
  const flag = flagOf(group);
  const who = whoOf(group);
  const runtime = group.investigation === undefined ? undefined : runtimeOf(group.investigation);
  const reportPath = group.investigation?.reportPath ?? group.actions.find(isLlmAct)?.reportPath;
  return {
    key: `${group.sessionId}:${startedAt}`,
    sessionId: group.sessionId,
    times: [
      { compact: compactAgo(startedAt, now), ago: agoLabel(startedAt, now) as string, full: fullTime(startedAt) },
    ],
    flag,
    who,
    whoLabel: WHO_LABEL[who],
    ...optional('runtime', runtime),
    result: groupResult(group),
    count: 1,
    timeline: timelineOf(group, flag, runtime, startedAt, reportPath),
    ...optional('reportPath', reportPath),
    ...(reportPath === undefined ? {} : { jev: jevBeforeLine(jevBeforeOf(group)) }),
  };
};

// ── The list ────────────────────────────────────────────────────────────────────────────────────

const sameColumns = (left: TriggerRow, right: TriggerRow): boolean =>
  left.sessionId === right.sessionId &&
  left.flag.label === right.flag.label &&
  left.who === right.who &&
  left.runtime === right.runtime &&
  left.result.label === right.result.label &&
  left.result.note === right.result.note;

/**
 * Newest first — one row per trigger — with each run of identical consecutive triggers folded into one
 * `×N` row. `now` is only for the "1h ago" words.
 */
export const triggerRows = (status: WardenStatusView, now: number): readonly TriggerRow[] => {
  const ordered = joinRecords(status)
    .map(group => ({ at: ms(startedAtOf(group)), row: rowOf(group, now) }))
    .sort((left, right) => right.at - left.at);
  const folded: TriggerRow[] = [];
  for (const { row } of ordered) {
    const last = folded[folded.length - 1];
    if (last !== undefined && sameColumns(last, row))
      folded[folded.length - 1] = { ...last, count: last.count + 1, times: [...last.times, ...row.times] };
    else folded.push(row);
  }
  return folded;
};

export const filterTriggerRows = (rows: readonly TriggerRow[], filters: TriggerFilters): readonly TriggerRow[] =>
  rows.filter(
    row =>
      (filters.who === 'all' || row.who === filters.who) &&
      (filters.result === 'all' || row.result.key === filters.result),
  );

/** How many triggers the rows stand for, repeats counted. */
export const triggerTotal = (rows: readonly TriggerRow[]): number => rows.reduce((sum, row) => sum + row.count, 0);

/** The Result filter: every result in the one order, each with how many triggers have it. */
export const resultFilterOptions = (
  rows: readonly TriggerRow[],
): readonly { readonly key: ResultFilter; readonly label: string }[] => [
  { key: 'all', label: `All results · ${triggerTotal(rows)}` },
  ...RESULT_ORDER.map(key => ({
    key,
    label: `${RESULTS[key].label} · ${triggerTotal(rows.filter(row => row.result.key === key))}`,
  })),
];

export interface TriggerPage {
  readonly rows: readonly TriggerRow[];
  /** How many more rows "Show more" would reveal. */
  readonly hidden: number;
}

export const pageTriggerRows = (rows: readonly TriggerRow[], pages: number): TriggerPage => {
  const shown = Math.max(1, pages) * TRIGGERS_PAGE;
  return { rows: rows.slice(0, shown), hidden: Math.max(0, rows.length - shown) };
};
