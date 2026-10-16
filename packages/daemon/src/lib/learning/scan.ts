import type { LearningScanProgress, LearningScanScope } from '../../../../protocol/src/lib/learning.ts';
import type { ScanRecord } from './types.ts';

/**
 * ACTIVE SCAN — which ferrets a scan reads, what it would cost, and how far it got. Pure.
 *
 * A scan never starts by itself: the owner asks for an estimate, sees it, and starts it. The estimate
 * spends nothing — it counts the characters of the digests a miner would be handed.
 */

/** One ferret as a scan considers it. */
export interface ScanCandidate {
  readonly sessionId: string;
  readonly cwd: string;
  readonly createdAt: string;
  readonly label?: string | undefined;
  /** Whether the daemon recorded where its transcript is: a ferret without one cannot be mined. */
  readonly hasTranscript: boolean;
  /** Whether it is instructed to learn. */
  readonly passive: boolean;
}

export interface ScanSelection {
  readonly sessionIds: readonly string[];
  /** In scope, but with no transcript to read. */
  readonly skipped: number;
}

/** Whether `cwd` is `project` or inside it. */
const within = (cwd: string, project: string): boolean => {
  const root = project.replace(/\/+$/u, '');
  return cwd === root || cwd.startsWith(`${root}/`);
};

function inScope(candidate: ScanCandidate, scope: LearningScanScope): boolean {
  switch (scope.kind) {
    case 'not-passive':
      return !candidate.passive;
    case 'range': {
      const at = Date.parse(candidate.createdAt);
      return at >= Date.parse(scope.from) && at <= Date.parse(scope.to);
    }
    case 'projects':
      return scope.projects.some(project => within(candidate.cwd, project));
    default:
      return scope.sessionIds.includes(candidate.sessionId);
  }
}

/** The ferrets `scope` names, never a miner itself (`excludedLabel`), oldest first. */
export function selectScanSessions(
  candidates: readonly ScanCandidate[],
  scope: LearningScanScope,
  excludedLabel: string,
): ScanSelection {
  const matched = candidates
    .filter(candidate => candidate.label !== excludedLabel && inScope(candidate, scope))
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
  return {
    sessionIds: matched.filter(candidate => candidate.hasTranscript).map(candidate => candidate.sessionId),
    skipped: matched.filter(candidate => !candidate.hasTranscript).length,
  };
}

/** The miner's own instructions and answer, per miner, on top of the digests it reads. */
export const SCAN_PROMPT_TOKENS = 1_500;
export const SCAN_OUTPUT_TOKENS = 2_000;

/** Characters per token for the estimate: the usual rule of thumb for English and code. */
const CHARS_PER_TOKEN = 4;

export interface ScanCost {
  readonly miners: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** The tokens a scan would spend: every digest read once, `batchSize` ferrets per miner. */
export function estimateScan(digestCharacters: readonly number[], batchSize: number): ScanCost {
  const miners = Math.ceil(digestCharacters.length / Math.max(1, batchSize));
  const digestTokens = Math.ceil(digestCharacters.reduce((sum, chars) => sum + chars, 0) / CHARS_PER_TOKEN);
  return {
    miners,
    inputTokens: digestTokens + miners * SCAN_PROMPT_TOKENS,
    outputTokens: miners * SCAN_OUTPUT_TOKENS,
  };
}

/** `ids` in batches of at most `size`. */
export function batchesOf<T>(ids: readonly T[], size: number): readonly (readonly T[])[] {
  const width = Math.max(1, size);
  const batches: T[][] = [];
  for (let start = 0; start < ids.length; start += width) batches.push(ids.slice(start, start + width));
  return batches;
}

/** A stored scan as the wire shows it. */
export function scanProgress(record: ScanRecord): LearningScanProgress {
  return {
    runId: record.runId,
    state: record.state,
    total: record.sessionIds.length,
    done: Math.min(record.done, record.sessionIds.length),
    startedAt: record.startedAt,
    ...(record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt }),
    added: record.added,
    merged: record.merged,
    ...(record.message === undefined ? {} : { message: record.message }),
  };
}
