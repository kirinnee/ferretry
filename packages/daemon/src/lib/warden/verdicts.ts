/**
 * Parse warden reports into a compact, UI-friendly verdict list: which session
 * the warden acted on, what it decided, and why.
 *
 * Reports are LLM-authored markdown and come in two shapes:
 *
 * - fleet triage — one file covering several `## Anomaly: <id> — <teammate> / <label>` blocks
 * - assigned — one file for one session, identified by its `# Warden report — <id>` header
 *
 * The prompt mandates a machine line (`Verdict: LEAVE|NUDGE|RESUME|KILL|
 * NEEDS_HUMAN`); prose heuristics are a best-effort fallback for when the model
 * drifts off the template, and never carry the authority the marker does.
 *
 * Pure: it is handed `{ path, content, mtimeMs }` and returns entries. The
 * reading lives in the adapter.
 */

import type { WardenAnomalyKind } from './detect.ts';
import { isoFromMs } from './time.ts';

export type WardenVerdictKind = 'killed' | 'revived' | 'nudged' | 'cleared' | 'needs_human' | 'unknown';

/** A concrete next step lifted from the report. `migrate` carries the account
 *  the report named so the UI never has to guess a target. */
export type WardenRecommendedAction = 'nudge' | 'stop' | 'resume' | 'restart' | 'migrate' | 'leave';

export interface WardenRecommendation {
  readonly action: WardenRecommendedAction;
  readonly reason: string;
  /** Required for `migrate`, absent otherwise. */
  readonly agent?: string;
}

export interface WardenVerdict {
  /** Sweep instant, taken from the report title and falling back to file mtime. */
  readonly at: string;
  readonly targetSession?: string;
  readonly teammate?: string;
  readonly label?: string;
  /** The exact anomaly class this block judged. */
  readonly anomalyKind?: WardenAnomalyKind;
  readonly verdict: WardenVerdictKind;
  /** True only when the verdict came from an explicit `Verdict: NEEDS_HUMAN`
   *  marker. Attention requests require the marker; heuristic prose stays report
   *  history and never interrupts a human on its own. */
  readonly explicitNeedsHuman?: boolean;
  readonly recommendation?: WardenRecommendation;
  readonly reason?: string;
  readonly reportPath: string;
}

export interface WardenReportFile {
  readonly path: string;
  readonly content: string;
  readonly mtimeMs: number;
}

const MARKER_MAP: Readonly<Record<string, WardenVerdictKind>> = {
  KILL: 'killed',
  RESUME: 'revived',
  NUDGE: 'nudged',
  LEAVE: 'cleared',
  NEEDS_HUMAN: 'needs_human',
};

const RECOMMENDED_ACTIONS: ReadonlySet<string> = new Set<WardenRecommendedAction>([
  'nudge',
  'stop',
  'resume',
  'restart',
  'migrate',
  'leave',
]);

const WARDEN_ANOMALY_KINDS: ReadonlySet<string> = new Set<WardenAnomalyKind>([
  'dead_monitor',
  'unattended_question',
  'abandoned_wreckage',
  'quota_reset_passed',
  'declared_wait_overdue',
  'peer_wait_unanswerable',
  'sus_thinking',
  'sus_subprocess',
  'provider_unavailable',
]);

export function parseWardenAnomalyKind(value: string | undefined): WardenAnomalyKind | undefined {
  const normalized = value?.trim();
  return normalized !== undefined && WARDEN_ANOMALY_KINDS.has(normalized)
    ? (normalized as WardenAnomalyKind)
    : undefined;
}

export interface WardenVerdictSourceIdentity {
  readonly reportPath?: string;
  readonly anomalyKind?: WardenAnomalyKind;
}

/** Stable attention-source identity for one exact report block. Generated
 *  report paths never contain `#`, so the suffix is an unambiguous selector. */
export function wardenVerdictSourceRef(
  reportPath: string | undefined,
  anomalyKind: WardenAnomalyKind | undefined,
): string | undefined {
  if (reportPath !== undefined && anomalyKind !== undefined) return `warden:${reportPath}#${anomalyKind}`;
  if (reportPath !== undefined) return `warden:${reportPath}`;
  if (anomalyKind !== undefined) return `warden:${anomalyKind}`;
  return undefined;
}

export function parseWardenVerdictSourceRef(sourceRef: string | undefined): WardenVerdictSourceIdentity | undefined {
  if (sourceRef === undefined || !sourceRef.startsWith('warden:')) return undefined;
  const exact = sourceRef.slice('warden:'.length);
  if (exact === '') return undefined;
  const separator = exact.lastIndexOf('#');
  if (separator > 0) {
    const anomalyKind = parseWardenAnomalyKind(exact.slice(separator + 1));
    const reportPath = exact.slice(0, separator);
    if (anomalyKind !== undefined && reportPath !== '') return { reportPath, anomalyKind };
  }
  const anomalyKind = parseWardenAnomalyKind(exact);
  return anomalyKind === undefined ? { reportPath: exact } : { anomalyKind };
}

function reportedAnomalyKind(content: string): WardenAnomalyKind | undefined {
  const marker = /^\s*[-*]\s+\*\*Anomaly kind:\*\*\s*`?([a-z_]+)\b/im.exec(content);
  return parseWardenAnomalyKind(marker?.[1]);
}

/** The mandated machine marker, if the report carried one. */
export function structuredVerdict(content: string): WardenVerdictKind | undefined {
  const marker = /^\s*(?:[-*]\s*)?(?:\*\*)?verdict:?\s*(?:\*\*)?\s*(LEAVE|NUDGE|RESUME|KILL|NEEDS[_ -]+HUMAN)\b/im.exec(
    content,
  );
  if (marker?.[1] === undefined) return undefined;
  return MARKER_MAP[marker[1].toUpperCase().replaceAll(/[- ]+/g, '_')];
}

/**
 * Best-effort classification of a report that omitted the marker.
 *
 * "Needs a human" wins over the action words that prose routinely mentions
 * while *rejecting* an option. The action patterns deliberately require the
 * warden as the actor: an unqualified "stopped" describes a subprocess far more
 * often than it describes the warden killing a session, and reading it as a
 * kill turned advisory reports into apparent executions.
 */
export function classifyVerdictHeuristically(content: string): WardenVerdictKind {
  const text = content.toLowerCase();
  if (
    /no safe.{0,20}action|needs?\s+a\s+human|no action (was )?taken|still needs a human|human (intervention|decision|is needed)/.test(
      text,
    )
  )
    return 'needs_human';
  if (/\bkill(ed|ing)\b|\bfy stop\b|stopped the session|killed the session/.test(text)) return 'killed';
  if (/\bresum(ed|ing)\b|\brevived\b/.test(text)) return 'revived';
  if (/\bnudg(ed|ing)\b/.test(text)) return 'nudged';
  if (/\bleft (it )?alone\b|left as-is|no action needed|no action required/.test(text)) return 'cleared';
  return 'unknown';
}

/** Classify a report: the structured marker wins, prose heuristics fall back. */
export function classifyVerdict(content: string): WardenVerdictKind {
  return structuredVerdict(content) ?? classifyVerdictHeuristically(content);
}

function titleTime(content: string): string | undefined {
  return /sweep\s+\(?([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z)/.exec(content)?.[1];
}

interface AnomalyBlock {
  readonly session: string;
  readonly teammate?: string;
  readonly label?: string;
  readonly block: string;
}

/** Split a fleet-triage report into its per-anomaly blocks. */
function anomalyBlocks(content: string): readonly AnomalyBlock[] {
  const blocks: AnomalyBlock[] = [];
  // Split on markdown H2 headers, keeping each header with its own block.
  for (const section of content.split(/\n(?=##\s)/)) {
    const head = /^##\s+Anomaly:\s*(?:`([^`\n]+)`|([A-Za-z0-9._-]+))\s*(?:(?:—|–|-)\s*(.*?))?\s*$/m.exec(section);
    const session = (head?.[1] ?? head?.[2])?.trim();
    if (session === undefined || session === '') continue;
    const rest = (head?.[3] ?? '').trim();
    const slash = rest.indexOf('/');
    const teammate = (slash >= 0 ? rest.slice(0, slash) : rest).trim();
    const label = slash >= 0 ? rest.slice(slash + 1).trim() : '';
    blocks.push({
      session,
      ...(teammate === '' ? {} : { teammate }),
      ...(label === '' ? {} : { label }),
      block: section,
    });
  }
  return blocks;
}

function reportedReason(block: string): string | undefined {
  return /\*\*Reported reason:\*\*\s*`?([^\n]+?)`?\s*(?:\n|$)/.exec(block)?.[1]?.trim();
}

/**
 * The compact report contract keeps the instruction actionable and parseable:
 * `- **Recommended action:** NUDGE — Ask the session to restate its blocker.`
 * `MIGRATE` must name an account in parentheses; a `MIGRATE` with no target is
 * not actionable, so it is dropped rather than surfaced as a broken button.
 */
function reportedRecommendation(content: string): WardenRecommendation | undefined {
  const match =
    /^\s*[-*]\s+\*\*Recommended action:\*\*\s*(NUDGE|STOP|RESUME|RESTART|MIGRATE|LEAVE)(?:\s*\(([^)\n]+)\))?\s*(?:—|–|-)\s*([^\n]+?)\s*$/im.exec(
      content,
    );
  if (match?.[1] === undefined) return undefined;
  const action = match[1].toLowerCase();
  const reason = (match[3] ?? '').trim();
  if (!RECOMMENDED_ACTIONS.has(action) || reason === '') return undefined;
  const agent = match[2]?.trim();
  if (action === 'migrate' && (agent === undefined || agent === '')) return undefined;
  return {
    action: action as WardenRecommendedAction,
    reason,
    ...(agent === undefined || agent === '' ? {} : { agent }),
  };
}

const flatten = (value: string): string => value.replaceAll(/\s+/g, ' ').trim();

/** The one-line reason shown next to a verdict row. */
function verdictSummary(content: string): string | undefined {
  // `**Verdict:** KILL — the reason`, both with and without the leading word.
  const bold = /\*\*(?:Warden )?verdict:?\*\*\s*(?:\w+\s*[—–-]\s*)?([^\n]+(?:\n(?!\n)[^\n]+)*)/i.exec(content);
  if (bold?.[1] !== undefined && flatten(bold[1]) !== '') return flatten(bold[1]);
  // Verdict word INSIDE the bold — `**Verdict: LEAVE.** The subprocess is …` —
  // where the reason is the prose after the closing asterisks.
  const boldInside = /\*\*(?:Warden )?verdict:?\s+[a-z_ -]+[.!]?\*\*\s*([^\n]+(?:\n(?!\n)[^\n]+)*)/i.exec(content);
  if (boldInside?.[1] !== undefined && flatten(boldInside[1]) !== '') return flatten(boldInside[1]);
  const outcome = /^\s*[-*]\s+\*\*Outcome:\*\*\s*([^\n]+(?:\n(?!\n)[^\n]+)*)/im.exec(content);
  if (outcome?.[1] !== undefined && flatten(outcome[1]) !== '') return flatten(outcome[1]);
  return firstSummaryLine(content);
}

/**
 * The first line under `## Summary`. Only the first: flattening the whole
 * section turns a compact verdict into a wall of evidence in the fleet list.
 * An empty section yields nothing — reading on into the next heading would put
 * `## Evidence` in the reason column.
 */
function firstSummaryLine(content: string): string | undefined {
  const heading = /^##[^\S\n]+Summary[^\S\n]*$/im.exec(content);
  if (heading === null) return undefined;
  for (const line of content.slice(heading.index + heading[0].length).split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    if (trimmed.startsWith('#')) return undefined;
    return flatten(trimmed.replace(/^[-*]\s+/, ''));
  }
  return undefined;
}

interface AssignedHeader {
  readonly session: string;
  readonly teammate?: string;
  readonly label?: string;
}

/** Assigned-report header: `# Warden report — <sessionId> (teammate <name>, <label>)`. */
function assignedHeader(content: string): AssignedHeader | undefined {
  const match =
    /^#\s+Warden report\s*(?:—|-)\s*([A-Za-z0-9._-]+)\s*(?:\(\s*teammate\s+([^,)]+?)\s*(?:,\s*([^)]+?)\s*)?\))?/m.exec(
      content,
    );
  const session = match?.[1]?.trim();
  if (session === undefined || session === '') return undefined;
  const teammate = match?.[2]?.trim();
  const label = match?.[3]?.trim();
  return {
    session,
    ...(teammate === undefined || teammate === '' ? {} : { teammate }),
    ...(label === undefined || label === '' ? {} : { label }),
  };
}

/** Session id embedded in an assigned report filename `<instant>-<sessionId>.md`. */
function filenameSession(path: string): string | undefined {
  const base = path.split('/').pop() ?? path;
  return /Z-([a-z0-9]+-[0-9a-f]{6,})\.md$/i.exec(base)?.[1];
}

export const DEFAULT_VERDICT_LIMIT = 20;

/**
 * Parse a batch of report files into verdict entries, newest first, capped at
 * `limit`. Files with identical mtimes are ordered by path so the same input
 * always produces the same output.
 */
export function parseWardenReports(
  files: readonly WardenReportFile[],
  limit = DEFAULT_VERDICT_LIMIT,
): readonly WardenVerdict[] {
  if (limit <= 0) return [];
  const sorted = files.toSorted((left, right) =>
    left.mtimeMs === right.mtimeMs ? left.path.localeCompare(right.path) : right.mtimeMs - left.mtimeMs,
  );
  const entries: WardenVerdict[] = [];

  for (const file of sorted) {
    const at = titleTime(file.content) ?? isoFromMs(file.mtimeMs);
    const fileMarker = structuredVerdict(file.content);
    const reportVerdict = fileMarker ?? classifyVerdictHeuristically(file.content);
    const reportSummary = verdictSummary(file.content);
    const blocks = anomalyBlocks(file.content);

    if (blocks.length === 0) {
      // Assigned format: identity lives in the header, with the filename as a
      // backstop when the model dropped the header.
      const header = assignedHeader(file.content);
      const targetSession = header?.session ?? filenameSession(file.path);
      entries.push({
        at,
        ...(targetSession === undefined ? {} : { targetSession }),
        ...(header?.teammate === undefined ? {} : { teammate: header.teammate }),
        ...(header?.label === undefined ? {} : { label: header.label }),
        ...pick('anomalyKind', reportedAnomalyKind(file.content)),
        verdict: reportVerdict,
        ...(fileMarker === 'needs_human' ? { explicitNeedsHuman: true } : {}),
        ...pick('recommendation', reportedRecommendation(file.content)),
        ...pick('reason', reportSummary),
        reportPath: file.path,
      });
    } else {
      for (const anomaly of blocks) {
        const blockMarker = structuredVerdict(anomaly.block);
        // A single-anomaly report may legitimately keep its marker above the
        // block. A multi-anomaly report must not: copying one global action
        // onto every target, or inferring one from incidental action words,
        // reports executions that never happened. An unmarked block in a
        // multi-anomaly report stays explicitly unknown.
        const marker = blockMarker ?? (blocks.length === 1 ? fileMarker : undefined);
        const verdict = marker ?? (blocks.length === 1 ? reportVerdict : 'unknown');
        entries.push({
          at,
          targetSession: anomaly.session,
          ...(anomaly.teammate === undefined ? {} : { teammate: anomaly.teammate }),
          ...(anomaly.label === undefined ? {} : { label: anomaly.label }),
          ...pick('anomalyKind', reportedAnomalyKind(anomaly.block)),
          verdict,
          ...(marker === 'needs_human' ? { explicitNeedsHuman: true } : {}),
          ...pick('recommendation', reportedRecommendation(anomaly.block)),
          ...pick(
            'reason',
            verdictSummary(anomaly.block) ??
              reportedReason(anomaly.block) ??
              (blocks.length === 1 ? reportSummary : undefined),
          ),
          reportPath: file.path,
        });
      }
    }

    if (entries.length >= limit) break;
  }

  return entries.slice(0, limit);
}

/** Include a key only when its value is defined, so verdicts never carry
 *  explicit `undefined` members that break equality comparisons. */
function pick<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
