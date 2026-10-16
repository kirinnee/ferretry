/**
 * The Learning hub's vocabulary, as pure functions: which tab a lesson is in, what its chips say, how a
 * diff line is read, what a scan's scope and estimate say. Nothing here reads the network or the clock.
 */

import type {
  EvidenceView,
  LearningScanEstimate,
  LearningScanProgress,
  LearningScanScope,
  ProposalCategory,
  ProposalSource,
  ProposalState,
  ProposalView,
  SessionView,
} from '@ferretry/protocol';
import { displayCallsign, shortSessionId } from '../../lib/callsign.ts';

/** The four tabs, in the order the hub shows them. */
export const LESSON_TABS: readonly { readonly state: ProposalState; readonly label: string }[] = [
  { state: 'pending', label: 'To review' },
  { state: 'accepted', label: 'Accepted' },
  { state: 'applied', label: 'Applied' },
  { state: 'rejected', label: 'Rejected' },
];

export type SourceFilter = 'all' | ProposalSource;

export const SOURCE_FILTERS: readonly { readonly id: SourceFilter; readonly label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'passive', label: 'Passive' },
  { id: 'scan', label: 'Scan' },
];

export const matchesSource = (proposal: ProposalView, filter: SourceFilter): boolean =>
  filter === 'all' || proposal.source === filter;

/** The lessons one tab shows, newest first. */
export const lessonsIn = (
  proposals: readonly ProposalView[],
  state: ProposalState,
  filter: SourceFilter,
): readonly ProposalView[] =>
  proposals
    .filter(proposal => proposal.state === state && matchesSource(proposal, filter))
    .toSorted((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen));

export const lessonCount = (proposals: readonly ProposalView[], state: ProposalState, filter: SourceFilter): number =>
  proposals.filter(proposal => proposal.state === state && matchesSource(proposal, filter)).length;

/** The empty state of one tab, naming the source filter when one narrows it. */
export const emptyTabSentence = (state: ProposalState, filter: SourceFilter): string => {
  const label = LESSON_TABS.find(tab => tab.state === state)?.label.toLowerCase() ?? state;
  return `No ${label} lessons${filter === 'all' ? '' : ` from ${filter}`}.`;
};

/** The last segment of a path, which is how a reader names a project. */
export const basename = (path: string): string => {
  const trimmed = path.replace(/[\\/]+$/u, '');
  return trimmed.split(/[\\/]/u).at(-1) || path;
};

/** A strong lesson was filed at least this many times. */
export const STRONG_LESSON_COUNT = 5;

export const strengthLabel = (count: number): string => `${count}×`;

export const typeLabel = (category: ProposalCategory, project: string | undefined): string =>
  category === 'global' ? 'Global' : project === undefined ? 'Repo' : `Repo · ${basename(project)}`;

/** How the hub names a session: its ferret's name, else the name the evidence carries, else a short id. */
export const sessionName = (
  sessionId: string,
  sessions: ReadonlyMap<string, SessionView>,
  teammate?: string,
): string =>
  displayCallsign(sessions.get(sessionId)?.config.teammate) || displayCallsign(teammate) || shortSessionId(sessionId);

/** The evidence the lesson was first filed with: the ferret that suggested it. */
const firstEvidence = (proposal: ProposalView): EvidenceView | undefined =>
  proposal.evidence.toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];

export const lessonSourceLabel = (proposal: ProposalView, sessions: ReadonlyMap<string, SessionView>): string => {
  if (proposal.source === 'scan') return 'scan';
  const first = firstEvidence(proposal);
  return first === undefined ? 'passive' : `passive · ${sessionName(first.sessionId, sessions, first.teammate)}`;
};

/** Who picked the lesson's type, for "the ferret picked X; you can change it". */
export const pickedSentence = (proposal: ProposalView): string => {
  const picked = proposal.suggestedCategory ?? proposal.category;
  const who = proposal.source === 'scan' ? 'The scan' : 'The ferret';
  return `${who} picked ${picked === 'global' ? 'Global' : 'Repo'}; you can change it.`;
};

export type DiffLineKind = 'add' | 'remove' | 'hunk' | 'meta' | 'context';

export interface DiffLine {
  readonly kind: DiffLineKind;
  readonly text: string;
}

/** Reads a unified diff line by line. The file headers are metadata, not removals or additions. */
export const diffLines = (diff: string): readonly DiffLine[] =>
  diff
    .replace(/\n$/u, '')
    .split('\n')
    .map(text => {
      if (text.startsWith('+++') || text.startsWith('---')) return { kind: 'meta', text };
      if (text.startsWith('@@')) return { kind: 'hunk', text };
      if (text.startsWith('+')) return { kind: 'add', text };
      if (text.startsWith('-')) return { kind: 'remove', text };
      return { kind: 'context', text };
    });

export const diffSummary = (diff: string): string => {
  const lines = diffLines(diff);
  const added = lines.filter(line => line.kind === 'add').length;
  const removed = lines.filter(line => line.kind === 'remove').length;
  return [added > 0 ? `+${added}` : '', removed > 0 ? `−${removed}` : ''].filter(Boolean).join(' ') || 'no change';
};

// ── Scan ─────────────────────────────────────────────────────────────────────────────────────────

export type ScanScopeKind = LearningScanScope['kind'];

export const SCAN_SCOPES: readonly { readonly kind: ScanScopeKind; readonly label: string; readonly hint?: string }[] =
  [
    {
      kind: 'not-passive',
      label: 'Ferrets without passive learning',
      hint: 'The default — older ferrets, or ones not instructed to learn.',
    },
    { kind: 'range', label: 'A date range' },
    { kind: 'projects', label: 'Projects' },
    { kind: 'sessions', label: 'Specific ferrets' },
  ];

/** What the reader has filled in, before it is a scope the daemon accepts. */
export interface ScanDraft {
  readonly kind: ScanScopeKind;
  /** `YYYY-MM-DD`, the reader's own calendar day. */
  readonly from: string;
  readonly to: string;
  readonly projects: readonly string[];
  readonly sessionIds: readonly string[];
  /** `''` is the machine's `learning.yaml` agent. */
  readonly agent: string;
  /** `''` is the login's default model. */
  readonly model: string;
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** A local calendar day as `YYYY-MM-DD`. */
export const calendarDay = (at: number): string => {
  const date = new Date(at);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

const DAY_MS = 86_400_000;

export const initialScanDraft = (now: number, scope?: LearningScanScope): ScanDraft => ({
  kind: scope?.kind ?? 'not-passive',
  from: calendarDay(now - 7 * DAY_MS),
  to: calendarDay(now),
  projects: scope?.kind === 'projects' ? scope.projects : [],
  sessionIds: scope?.kind === 'sessions' ? scope.sessionIds : [],
  agent: '',
  model: '',
});

/** The start of a local day, and the last millisecond of one, as instants. */
const dayStart = (day: string): string | undefined => {
  const at = new Date(`${day}T00:00:00`).getTime();
  return Number.isFinite(at) ? new Date(at).toISOString() : undefined;
};
const dayEnd = (day: string): string | undefined => {
  const at = new Date(`${day}T00:00:00`).getTime();
  return Number.isFinite(at) ? new Date(at + DAY_MS - 1).toISOString() : undefined;
};

/** The scope a draft names, or why it does not name one yet. */
export const scopeFromDraft = (draft: ScanDraft): LearningScanScope | string => {
  switch (draft.kind) {
    case 'not-passive':
      return { kind: 'not-passive' };
    case 'range': {
      const from = dayStart(draft.from);
      const to = dayEnd(draft.to);
      if (from === undefined || to === undefined) return 'Pick both days.';
      if (from > to) return 'The first day must come before the last.';
      return { kind: 'range', from, to };
    }
    case 'projects':
      return draft.projects.length === 0
        ? 'Pick at least one project.'
        : { kind: 'projects', projects: [...draft.projects] };
    case 'sessions':
      return draft.sessionIds.length === 0
        ? 'Pick at least one ferret.'
        : { kind: 'sessions', sessionIds: [...draft.sessionIds] };
  }
};

/** Toggles one value in a list, keeping the list's order. */
export const toggled = (values: readonly string[], value: string): readonly string[] =>
  values.includes(value) ? values.filter(candidate => candidate !== value) : [...values, value];

const tokenFormat = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

export const formatScanTokens = (tokens: number): string => tokenFormat.format(tokens);

export const formatScanUsd = (usd: number): string => (usd < 0.01 && usd > 0 ? '<$0.01' : `$${usd.toFixed(2)}`);

/** The estimate's headline: N ferrets, ~X tokens, ~$Y — or "cost unknown", never a guessed number. */
export const estimateParts = (estimate: LearningScanEstimate): readonly string[] => [
  `${estimate.sessions} ferret${estimate.sessions === 1 ? '' : 's'}`,
  `~${formatScanTokens(estimate.tokens)} tokens`,
  estimate.usd === undefined ? 'cost unknown' : `~${formatScanUsd(estimate.usd)}`,
];

export const estimateNotes = (estimate: LearningScanEstimate): readonly string[] => [
  ...(estimate.skipped > 0
    ? [`${estimate.skipped} skipped: no transcript to read.`]
    : []),
  ...(estimate.beyondLimit > 0
    ? [`${estimate.beyondLimit} more beyond this scan’s limit — scan again for them.`]
    : []),
];

export const scanPercent = (progress: LearningScanProgress): number =>
  progress.total === 0 ? 0 : Math.round((Math.min(progress.done, progress.total) / progress.total) * 100);

export const scanReadingSentence = (progress: LearningScanProgress): string =>
  progress.total === 0
    ? 'Starting the scan…'
    : `Reading ferret ${Math.min(progress.total, progress.done + 1)} of ${progress.total}…`;

export const scanResultSentence = (progress: LearningScanProgress): string => {
  if (progress.state === 'cancelled') return 'Scan cancelled. Lessons it had already found stay in To review.';
  if (progress.state === 'failed') return `The scan failed${progress.message ? `: ${progress.message}` : '.'}`;
  const added =
    progress.added === 0
      ? 'No new lessons'
      : `Added ${progress.added} lesson${progress.added === 1 ? '' : 's'} to To review`;
  return `${added}${progress.merged > 0 ? ` and merged ${progress.merged} into existing ones` : ''}.`;
};

const ABSOLUTE_FIELDS = ['year', 'month', 'day', 'hour', 'minute'] as const;

/**
 * `yyyy-MM-dd HH:mm` in the reader's own zone. Evidence is an audit trail — "when exactly" is the
 * question a quote raises. `timeZone` is a parameter so a test can pin it; production passes nothing.
 */
export const lessonTime = (at: string, timeZone?: string): string => {
  const timestamp = Date.parse(at);
  if (!Number.isFinite(timestamp)) return at;
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...(timeZone === undefined ? {} : { timeZone }),
  }).formatToParts(new Date(timestamp));
  const [year, month, day, hour, minute] = ABSOLUTE_FIELDS.map(
    field => parts.find(part => part.type === field)?.value ?? '',
  );
  return `${year}-${month}-${day} ${hour}:${minute}`;
};
