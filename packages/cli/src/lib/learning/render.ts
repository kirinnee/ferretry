import type {
  EvidenceView,
  LearningApplyPreview,
  LearningConfig,
  LearningPatchResponse,
  LearningScanEstimate,
  LearningScanProgress,
  LearningStatus,
  ProposalView,
  RunManifest,
} from '@ferretry/protocol';

/** Widest a quote or rule is printed at before it is elided. */
const RULE_WIDTH = 96;
const QUOTE_WIDTH = 72;

const INDENT = '    ';

const compact = (value: string, width: number): string => {
  const line = value.replaceAll(/\s+/gu, ' ').trim();
  return line.length > width ? `${line.slice(0, width - 1)}…` : line;
};

const plural = (count: number, singular: string, pluralForm = `${singular}s`): string =>
  `${count} ${count === 1 ? singular : pluralForm}`;

/**
 * How much weight a proposal carries.
 *
 * A rule seen once in one repository is a coincidence; the same correction in several repositories
 * is a habit. Both numbers are shown because they answer different questions.
 */
function weight(proposal: ProposalView): string {
  return `${plural(proposal.occurrences, 'occurrence')} across ${plural(proposal.crossRepoCount, 'repo')}`;
}

function evidenceLine(evidence: EvidenceView): string {
  const who = evidence.teammate === undefined ? evidence.source : `${evidence.source} ${evidence.teammate}`;
  return `${INDENT}· [${evidence.kind}] ${who} in ${evidence.repo} at ${evidence.at}\n${INDENT}  "${compact(evidence.quote, QUOTE_WIDTH)}"`;
}

/** `Global` for every ferret, `Repo · <project>` for one project's own guidance. */
function typeChip(proposal: ProposalView): string {
  const kind = proposal.category === 'global' ? 'Global' : 'Repo';
  return proposal.project === undefined ? kind : `${kind} · ${proposal.project}`;
}

/** How strong a lesson reads and where it came from: the strength chip, then the chip naming who filed it. */
function strengthLine(proposal: ProposalView): string {
  return `${typeChip(proposal)} · ${proposal.source} · ${proposal.count}× · ${weight(proposal)} · last seen ${proposal.lastSeen}`;
}

/** One proposal as a list row: enough to decide whether to open it. */
function renderProposalRow(proposal: ProposalView): string {
  return [
    `  ${proposal.id}  [${proposal.state}]  ${compact(proposal.title, RULE_WIDTH)}`,
    `${INDENT}${strengthLine(proposal)}`,
    `${INDENT}→ ${proposal.target.kind} ${proposal.target.path}`,
  ].join('\n');
}

/** The proposal board. An empty board is worth saying plainly: nothing is waiting on the human. */
export function renderProposalList(proposals: readonly ProposalView[], state: string | undefined): string {
  const scope = state === undefined ? 'proposals' : `${state} proposals`;
  if (proposals.length === 0) return `No ${scope}.`;
  const header = `${plural(proposals.length, scope.replace(/s$/u, ''), scope)} — strongest first`;
  const ordered = [...proposals].sort(strongestFirst);
  return [header, ...ordered.map(renderProposalRow)].join('\n');
}

/**
 * Strongest first, so the rule with the most evidence is the one a human reads.
 *
 * kteam rendered whatever order the store yielded, which is creation order, so a one-off proposal
 * could sit above a rule corroborated a dozen times.
 */
function strongestFirst(left: ProposalView, right: ProposalView): number {
  if (left.occurrences !== right.occurrences) return right.occurrences - left.occurrences;
  if (left.crossRepoCount !== right.crossRepoCount) return right.crossRepoCount - left.crossRepoCount;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** One proposal in full: the rule, where it lands, and every quote behind it. */
export function renderProposalDetail(proposal: ProposalView): string {
  const history = proposal.history.map(entry => {
    const note = entry.note === undefined ? '' : ` — ${entry.note}`;
    return `${INDENT}· ${entry.at} ${entry.event} by ${entry.by}${note}`;
  });
  return [
    `${proposal.id}  [${proposal.state}]  ${proposal.title}`,
    `  rule: ${proposal.ruleText}`,
    `  type: ${typeChip(proposal)} · source: ${proposal.source} · strength: ${proposal.count}×`,
    `  target: ${proposal.target.kind} ${proposal.target.path}${proposal.target.anchor === undefined ? '' : ` (${proposal.target.anchor})`}`,
    `  ${weight(proposal)} · first seen ${proposal.firstSeen} · last seen ${proposal.lastSeen}`,
    ...(proposal.applied === undefined ? [] : [`  applied ${proposal.applied.at} → ${proposal.applied.path}`]),
    `  evidence (${proposal.evidence.length}):`,
    ...proposal.evidence.map(evidenceLine),
    '  history:',
    ...history,
  ].join('\n');
}

/** Confirmation for accept/reject/edit, naming the state the proposal now holds. */
export function renderProposalAction(verb: string, proposal: ProposalView): string {
  return `${verb} ${proposal.id} — now ${proposal.state}: ${compact(proposal.title, RULE_WIDTH)}`;
}

/** The subsystem's health: is it on, what is waiting, and what the last run produced. */
export function renderLearningStatus(status: LearningStatus): string {
  const lines = [
    `learning is ${status.enabled ? 'enabled' : 'disabled'}, mining every ${plural(status.intervalMinutes, 'minute')}${status.running ? ' (a run is in progress)' : ''}`,
    `  pending: ${status.pending.total} (${status.pending.strong} strong, ${status.pending.weak} weak)`,
    `  totals: ${plural(status.totals.observations, 'observation')}, ${plural(status.totals.proposals, 'proposal')}, ${plural(status.totals.tombstones, 'tombstone')}`,
    `  watermark: ${status.watermarkAt ?? 'never'} · last run: ${status.lastRunAt ?? 'never'}`,
  ];
  if (status.lastRun !== undefined) lines.push(...renderRunManifest(status.lastRun).split('\n').map(indentOne));
  return lines.join('\n');
}

const indentOne = (line: string): string => `  ${line}`;

/** What one mining run scanned and produced. */
export function renderRunManifest(manifest: RunManifest): string {
  // The protocol's per-harness record is exhaustive over the harness enum, so this is never empty.
  const perHarness = Object.entries(manifest.perHarness)
    .map(([harness, count]) => `${harness}=${count}`)
    .join(' ');
  const lines = [
    `run ${manifest.runId} started ${manifest.startedAt}${manifest.finishedAt === undefined ? ' (still running)' : ` finished ${manifest.finishedAt}`}`,
    `  scanned ${manifest.sessionsScanned} sessions, ${manifest.sessionsWithSignal} with signal · ${perHarness}`,
    `  observations: ${manifest.observationsProposed} proposed, ${manifest.observationsVerified} verified, ${manifest.rejectedQuotes} quotes rejected, ${manifest.malformedFiles} files malformed`,
    `  proposals: ${manifest.proposalsCreated} created, ${manifest.proposalsStrengthened} strengthened, ${manifest.proposalsSuppressedByTombstone} suppressed`,
    `  miners: ${manifest.minerSessions.length === 0 ? 'none spawned' : manifest.minerSessions.join(', ')}`,
  ];
  if (manifest.message !== undefined) lines.push(`  ${manifest.message}`);
  return lines.join('\n');
}

/** The mining schedule and the agent that performs it. */
export function renderLearningConfig(config: LearningConfig): string {
  return [
    `learning is ${config.enabled ? 'enabled' : 'disabled'}`,
    `  miner: ${config.agent}${config.model === undefined ? '' : ` (${config.model})`}`,
    `  every ${plural(config.intervalMinutes, 'minute')}, batches of ${config.batchSize}`,
    `  per run: at most ${plural(config.maxMinersPerRun, 'miner')} over ${plural(config.maxSessionsPerRun, 'session')}`,
    `  minimum gap between spawns: ${plural(config.minSpawnGapMinutes, 'minute')}`,
  ].join('\n');
}

/**
 * The guidance file as the daemon would have it, printed for the human to apply.
 *
 * The daemon never writes this file — that is deliberate, the human owns their own guidance — so the
 * rendering says where it belongs rather than implying it has already landed.
 */
export function renderLearningPatch(patch: LearningPatchResponse): string {
  return [`${patch.path} — apply this yourself; the daemon never writes it`, patch.contents].join('\n');
}

/**
 * Exactly what Apply would write: the diff, where it goes, and anything else worth knowing before
 * writing it — then the exact re-run that actually writes it, because the preview alone never does.
 */
export function renderLearningApplyPreview(preview: LearningApplyPreview, bin: string): string {
  return [
    `${preview.proposalId}  [${preview.category}]  → ${preview.path}${preview.exists ? '' : ' (new file)'}`,
    preview.diff,
    ...preview.notes.map(note => `  note: ${note}`),
    `nothing written yet — re-run with --yes to apply: ${bin} learning apply ${preview.proposalId} --yes`,
  ].join('\n');
}

/** What a scan would cost, before it reads anything. */
export function renderLearningScanEstimate(estimate: LearningScanEstimate): string {
  const lines = [
    `${plural(estimate.sessions, 'session')} in scope (${estimate.skipped} skipped) · ${plural(estimate.miners, 'miner')} · ${estimate.agent}${estimate.model === undefined ? '' : ` (${estimate.model})`}`,
    `  ~${estimate.tokens} tokens${estimate.usd === undefined ? ', usd unknown' : ` · ~$${estimate.usd.toFixed(2)}`}`,
  ];
  if (estimate.sessionIds.length > 0) lines.push(`  ${estimate.sessionIds.join(', ')}`);
  if (estimate.beyondLimit > 0)
    lines.push(`  ${estimate.beyondLimit} more beyond this scan’s limit — scan again afterwards`);
  lines.push('nothing read yet — re-run with --start to scan');
  return lines.join('\n');
}

/** One scan's progress, as the daemon left it when this was asked. */
export function renderLearningScanProgress(progress: LearningScanProgress): string {
  const lines = [
    `scan ${progress.runId} [${progress.state}] ${progress.done}/${progress.total} started ${progress.startedAt}${progress.finishedAt === undefined ? '' : ` finished ${progress.finishedAt}`}`,
    `  added ${progress.added}, merged ${progress.merged}`,
  ];
  if (progress.message !== undefined) lines.push(`  ${progress.message}`);
  return lines.join('\n');
}
