import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, FileDown, GraduationCap, Pencil, RefreshCw, X } from 'lucide-react';
import type { LearningActionRequest, LearningStatus, ProposalView } from '@ferretry/protocol';

import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import {
  actOnLearningProposal,
  fetchLearningPatch,
  fetchLearningProposals,
  fetchLearningStatus,
  runLearningScan,
} from '../../lib/learning-api.ts';
import { Button } from '../../shell/primitives.tsx';

export type LearningStrength = 'weak' | 'normal' | 'strong';
export const learningStrength = (occurrences: number): LearningStrength =>
  occurrences >= 5 ? 'strong' : occurrences <= 1 ? 'weak' : 'normal';
export const learningErrorMessage = (reason: unknown): string =>
  reason instanceof Error ? reason.message : 'Learning is unavailable on this daemon.';

const relative = (value: string | undefined, now: number): string => {
  if (value === undefined) return '—';
  const milliseconds = Date.parse(value) - now;
  if (!Number.isFinite(milliseconds)) return '—';
  const minutes = Math.round(Math.abs(milliseconds) / 60_000);
  return minutes === 0 ? 'now' : `${minutes}m ${milliseconds <= 0 ? 'ago' : 'from now'}`;
};

export interface LearningPageProps {
  readonly connection: DaemonConnection;
  readonly now?: number;
}

/** First-class learning route; all work is scoped to the supplied paired daemon. */
export function LearningPage({ connection, now = Date.now() }: LearningPageProps) {
  const [status, setStatus] = useState<LearningStatus | null>(null);
  const [proposals, setProposals] = useState<readonly ProposalView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const [nextStatus, nextProposals] = await Promise.all([
        fetchLearningStatus(connection),
        fetchLearningProposals(connection),
      ]);
      setStatus(nextStatus);
      setProposals(nextProposals);
      setError(null);
    } catch (reason) {
      setError(learningErrorMessage(reason));
    }
  }, [connection]);
  useEffect(() => {
    setStatus(null);
    setProposals([]);
    void load();
  }, [load]);
  const act = useCallback(
    async (id: string, action: LearningActionRequest) => {
      setBusy(true);
      try {
        await actOnLearningProposal(connection, id, action);
        await load();
      } catch (reason) {
        setError(learningErrorMessage(reason));
      } finally {
        setBusy(false);
      }
    },
    [connection, load],
  );
  const run = useCallback(async () => {
    setBusy(true);
    try {
      await runLearningScan(connection, true);
      await load();
    } catch (reason) {
      setError(learningErrorMessage(reason));
    } finally {
      setBusy(false);
    }
  }, [connection, load]);
  return (
    <LearningReview
      connection={connection}
      status={status}
      proposals={proposals}
      error={error}
      busy={busy}
      now={now}
      onRun={run}
      onAction={act}
    />
  );
}

export interface LearningReviewProps {
  readonly connection: DaemonConnection;
  readonly status: LearningStatus | null;
  readonly proposals: readonly ProposalView[];
  readonly error: string | null;
  readonly busy: boolean;
  readonly now: number;
  readonly onRun: () => void;
  readonly onAction: (id: string, action: LearningActionRequest) => void;
}

/** Split from transport so it can be mounted for deterministic visual and render tests. */
export function LearningReview({
  connection,
  status,
  proposals,
  error,
  busy,
  now,
  onRun,
  onAction,
}: LearningReviewProps) {
  const pending = proposals.filter(proposal => proposal.state === 'pending');
  const accepted = proposals.filter(proposal => proposal.state === 'accepted');
  const rejected = proposals.filter(proposal => proposal.state === 'rejected');
  const group = (strength: LearningStrength) =>
    pending.filter(proposal => learningStrength(proposal.occurrences) === strength);
  return (
    <main
      className="h-full min-h-0 w-full overflow-y-auto scroll-thin pb-4"
      aria-label="Learning proposals"
      data-daemon={connection.daemonId}
    >
      <div className="mx-auto flex w-full max-w-[980px] flex-col gap-3 py-2">
        <header>
          <h1 className="m-0 flex items-center gap-sm font-display text-display font-bold tracking-display">
            <GraduationCap size={20} className="text-accent" aria-hidden="true" />
            Learning
          </h1>
          <p className="mt-0.5 text-ui text-muted">
            Recurring corrections mined from finished sessions, surfaced as global rule proposals. Every quote is
            verified against its transcript.
          </p>
        </header>
        <LearningHeader status={status} error={error} busy={busy} now={now} onRun={onRun} />
        {status === null && error === null && (
          <p role="status" className="text-ui text-muted">
            Reading learning proposals…
          </p>
        )}
        {error !== null && (
          <p role="alert" className="rounded-control border border-warn/30 bg-warn-soft px-3 py-2 text-ui text-warn">
            {error}
          </p>
        )}
        {pending.length === 0 && accepted.length === 0 && status !== null && (
          <p className="kt-panel p-3 text-ui text-muted">
            No proposals yet. Recurring corrections appear here for review.
          </p>
        )}
        <ProposalGroup
          label="Strong signals — seen across 5+ sessions"
          proposals={group('strong')}
          busy={busy}
          onAction={onAction}
          connection={connection}
        />
        <ProposalGroup
          label="Proposals"
          proposals={group('normal')}
          busy={busy}
          onAction={onAction}
          connection={connection}
        />
        {group('weak').length > 0 && (
          <details className="kt-panel p-3">
            <summary className="min-h-[44px] cursor-pointer text-ui font-medium text-muted">
              Weak signals (single occurrence) · {group('weak').length}
            </summary>
            <ProposalGroup label="" proposals={group('weak')} busy={busy} onAction={onAction} connection={connection} />
          </details>
        )}
        <ProposalGroup
          label="Accepted — apply by hand"
          proposals={accepted}
          busy={busy}
          onAction={onAction}
          connection={connection}
          accepted
        />
        {rejected.length > 0 && (
          <details className="kt-panel p-3">
            <summary className="min-h-[44px] cursor-pointer text-ui text-muted">
              Rejected (permanent) · {rejected.length}
            </summary>
            <ul className="m-0 list-none p-0 text-ui text-muted">
              {rejected.map(proposal => (
                <li key={proposal.id} className="line-through">
                  {proposal.title}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </main>
  );
}

function LearningHeader({
  status,
  error,
  busy,
  now,
  onRun,
}: {
  readonly status: LearningStatus | null;
  readonly error: string | null;
  readonly busy: boolean;
  readonly now: number;
  readonly onRun: () => void;
}) {
  return (
    <section
      className="kt-panel flex flex-wrap items-center gap-x-3 gap-y-1 p-3 text-meta"
      aria-label="Learning status"
    >
      <span className={status?.enabled ? 'text-ok' : 'text-muted'}>{status?.enabled ? 'enabled' : 'disabled'}</span>
      <span aria-hidden="true">·</span>
      <span className="mono text-muted">last run {relative(status?.lastRunAt, now)}</span>
      <span aria-hidden="true">·</span>
      <span className="mono text-muted">{status?.pending.total ?? 0} pending</span>
      {(status?.pending.strong ?? 0) > 0 && <span className="mono text-accent">{status?.pending.strong} strong</span>}
      {error !== null && <span className="mono text-warn">unavailable on this daemon</span>}
      <Button className="ml-auto min-h-[44px]" size="sm" disabled={busy} onClick={onRun}>
        <RefreshCw
          size={14}
          className={busy ? 'animate-spin motion-reduce:animate-none' : undefined}
          aria-hidden="true"
        />
        Run now
      </Button>
    </section>
  );
}

function ProposalGroup({
  label,
  proposals,
  busy,
  onAction,
  connection,
  accepted = false,
}: {
  readonly label: string;
  readonly proposals: readonly ProposalView[];
  readonly busy: boolean;
  readonly onAction: LearningReviewProps['onAction'];
  readonly connection: DaemonConnection;
  readonly accepted?: boolean;
}) {
  if (proposals.length === 0) return null;
  return (
    <section className="flex flex-col gap-3">
      {label !== '' && <h2 className="kt-label m-0">{label}</h2>}
      {proposals.map(proposal => (
        <ProposalCard
          key={proposal.id}
          proposal={proposal}
          busy={busy}
          onAction={onAction}
          connection={connection}
          accepted={accepted}
        />
      ))}
    </section>
  );
}

export function ProposalCard({
  proposal,
  busy,
  onAction,
  connection,
  accepted,
}: {
  readonly proposal: ProposalView;
  readonly busy: boolean;
  readonly onAction: LearningReviewProps['onAction'];
  readonly connection: DaemonConnection;
  readonly accepted: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(proposal.ruleText);
  const [copied, setCopied] = useState<'rule' | 'patch' | null>(null);
  const [patchError, setPatchError] = useState<string | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const strength = learningStrength(proposal.occurrences);

  useEffect(
    () => () => {
      if (copiedTimer.current !== undefined) clearTimeout(copiedTimer.current);
    },
    [],
  );

  const markCopied = (kind: 'rule' | 'patch') => {
    if (copiedTimer.current !== undefined) clearTimeout(copiedTimer.current);
    setCopied(kind);
    copiedTimer.current = setTimeout(() => setCopied(null), 1_500);
  };

  const copy = async () => {
    try {
      await navigator.clipboard?.writeText(proposal.ruleText);
      markCopied('rule');
    } catch {
      // The rule remains visible and selectable when the browser denies
      // clipboard access, so the control need not pretend the copy succeeded.
      setCopied(null);
    }
  };
  const savePatch = async () => {
    try {
      const patch = await fetchLearningPatch(connection, proposal.id);
      const url = URL.createObjectURL(new Blob([patch.contents], { type: 'text/markdown' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `${proposal.identity}.md`;
      link.click();
      URL.revokeObjectURL(url);
      setPatchError(null);
      markCopied('patch');
    } catch (reason) {
      setPatchError(learningErrorMessage(reason));
    }
  };
  return (
    <article className="kt-panel flex flex-col gap-2 p-3" aria-label={`Learning proposal ${proposal.title}`}>
      <div className="flex flex-wrap items-start gap-2">
        <span className="kt-badge" data-tone={strength === 'strong' ? 'accent' : strength === 'weak' ? 'pend' : 'ok'}>
          {proposal.occurrences}×
        </span>
        <span className="mono text-meta text-faint">
          {proposal.crossRepoCount} repo{proposal.crossRepoCount === 1 ? '' : 's'}
        </span>
        <h3 className="m-0 min-w-0 flex-1 text-ui font-semibold">{proposal.title}</h3>
      </div>
      <div className="mono text-meta text-faint">
        → {proposal.target.path}
        {proposal.target.anchor ? ` (${proposal.target.anchor})` : ''}
      </div>
      {editing ? (
        <textarea
          className="kt-input resize-y"
          rows={3}
          aria-label={`Edit rule text for ${proposal.title}`}
          value={draft}
          onChange={event => setDraft(event.target.value)}
        />
      ) : (
        <p className="m-0 whitespace-pre-wrap text-ui text-fg-soft">{proposal.ruleText}</p>
      )}
      <details className="rounded border border-border-soft bg-surface-1">
        <summary className="flex min-h-[44px] cursor-pointer list-none items-center px-2 text-meta font-medium text-muted">
          Evidence · {proposal.evidence.length} verified quote{proposal.evidence.length === 1 ? '' : 's'}
        </summary>
        <ul className="m-0 flex list-none flex-col gap-1 p-2 pt-0">
          {proposal.evidence.map(evidence => (
            <li key={evidence.observationId}>
              <a
                className="flex min-h-[44px] flex-col justify-center gap-0.5 rounded px-2 py-1 hover:bg-surface-2"
                href={`/d/${encodeURIComponent(connection.daemonId)}/session/${encodeURIComponent(evidence.sessionId)}`}
              >
                <span className="text-ui text-fg-soft">“{evidence.quote}”</span>
                <span className="mono text-meta text-faint">
                  {evidence.source === 'teammate' ? 'teammate steer' : 'human'}
                  {evidence.teammate ? ` · ${evidence.teammate}` : ''} · {evidence.repo} · {evidence.at}
                </span>
              </a>
            </li>
          ))}
        </ul>
      </details>
      <div className="flex flex-wrap gap-sm">
        {!accepted && !editing && (
          <>
            <Button
              size="sm"
              variant="primary"
              className="min-h-[44px] items-center gap-xs"
              disabled={busy}
              onClick={() => onAction(proposal.id, { action: 'accept' })}
              aria-label={`Accept ${proposal.title}`}
            >
              <Check size={14} aria-hidden="true" />
              Accept
            </Button>
            <Button
              size="sm"
              className="min-h-[44px] items-center gap-xs"
              onClick={() => setEditing(true)}
              aria-label={`Edit ${proposal.title}`}
            >
              <Pencil size={14} aria-hidden="true" />
              Edit
            </Button>
            <Button
              size="sm"
              variant="danger"
              className="min-h-[44px] items-center gap-xs"
              disabled={busy}
              onClick={() => onAction(proposal.id, { action: 'reject' })}
              aria-label={`Reject ${proposal.title} permanently`}
            >
              <X size={14} aria-hidden="true" />
              Reject
            </Button>
          </>
        )}
        {editing && (
          <>
            <Button
              size="sm"
              variant="primary"
              className="min-h-[44px] items-center gap-xs"
              disabled={busy || draft.trim() === ''}
              onClick={() => {
                onAction(proposal.id, { action: 'edit', ruleText: draft });
                setEditing(false);
              }}
              aria-label={`Save rule text for ${proposal.title}`}
            >
              <Check size={14} aria-hidden="true" />
              Save
            </Button>
            <Button
              size="sm"
              className="min-h-[44px]"
              onClick={() => {
                setDraft(proposal.ruleText);
                setEditing(false);
              }}
              aria-label={`Cancel editing ${proposal.title}`}
            >
              Cancel
            </Button>
          </>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="min-h-[44px] items-center gap-xs"
          onClick={() => void copy()}
          aria-label={`Copy rule text for ${proposal.title}`}
        >
          <Copy size={14} aria-hidden="true" />
          {copied === 'rule' ? 'Copied' : 'Copy rule'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="min-h-[44px] items-center gap-xs"
          onClick={() => void savePatch()}
          aria-label={`Save a patch file for ${proposal.title}`}
        >
          <FileDown size={14} aria-hidden="true" />
          {copied === 'patch' ? 'Saved' : 'Save patch'}
        </Button>
      </div>
      {patchError !== null && (
        <p role="alert" className="m-0 text-meta text-warn">
          {patchError}
        </p>
      )}
    </article>
  );
}
