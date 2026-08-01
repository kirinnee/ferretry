import type { LearningActionRequest, LearningStatus, ProposalView } from '@ferretry/protocol';
import { Check, Copy, FileDown, GraduationCap, Pencil, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { displayCallsign } from '../../lib/callsign.ts';
import { cn } from '../../lib/class-names.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import {
  actOnLearningProposal,
  fetchLearningPatch,
  fetchLearningProposals,
  fetchLearningStatus,
  runLearningScan,
} from '../../lib/learning-api.ts';
import { Button } from '../../shell/primitives.tsx';
import { LearningHeader } from './learning-header.tsx';
import { useTouchAffected } from './use-touch-affected.ts';

export type LearningStrength = 'weak' | 'normal' | 'strong';
export const learningStrength = (occurrences: number): LearningStrength =>
  occurrences >= 5 ? 'strong' : occurrences <= 1 ? 'weak' : 'normal';
export const learningErrorMessage = (reason: unknown): string =>
  reason instanceof Error ? reason.message : 'Learning is unavailable on this daemon.';

const ABSOLUTE_FIELDS = ['year', 'month', 'day', 'hour', 'minute', 'second'] as const;

/**
 * `yyyy-MM-dd HH:mm:ss` in the reader's own zone, matching the source page's
 * `fmtAbsolute`. Evidence is an audit trail — "when exactly" is the question a
 * quote raises, and a relative age cannot answer it.
 *
 * It stays local to this feature rather than joining `relativeTime` in
 * `session-screens.ts`: that module is the session surfaces' vocabulary, and
 * learning is the only caller that needs a second, absolute form.
 *
 * `timeZone` is a parameter because a formatter that silently reads an ambient
 * zone cannot be asserted; production passes nothing and gets the local zone.
 */
export const absoluteTime = (at: string | undefined, timeZone?: string): string => {
  if (at === undefined || at === '') return '—';
  const timestamp = Date.parse(at);
  if (!Number.isFinite(timestamp)) return at;
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    ...(timeZone === undefined ? {} : { timeZone }),
  }).formatToParts(new Date(timestamp));
  const [year, month, day, hour, minute, second] = ABSOLUTE_FIELDS.map(
    field => parts.find(part => part.type === field)?.value ?? '',
  );
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
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
  // `busy` is a count of in-flight same-scope operations, not a boolean: two
  // overlapping accepts/scans on one daemon keep the controls disabled until
  // both finish, and a scope change resets it to zero.
  const [busy, setBusy] = useState(0);

  // A daemon switch starts a fresh load, but everything the old daemon started —
  // the `Promise.all`, an in-flight accept, a running scan — is still on the
  // network. Left unfenced, its late settle would paint the old daemon over the
  // new one, or stamp the old daemon's error (or finalizer) across it.
  //
  // `scopeRef` is a monotonic epoch that advances on every daemonId change and
  // is never reused, so even an A→B→A round trip gives the second A a fresh
  // epoch and the first A's stale settle — whose daemonId would match again —
  // is still dropped. Each async op captures the epoch at launch and publishes
  // only while that epoch is still current.
  //
  // The epoch advances and the view clears *during render*, in the same pass
  // that sees the new daemonId (React's adjust-state-when-a-prop-changes
  // pattern), so the new daemon's render never briefly paints the old daemon's
  // data: the clear is committed before paint, not deferred to an effect.
  const scopeRef = useRef(0);
  // Loads can also overlap without a daemon switch: a slow initial read may
  // still be pending when an accept or scan finishes and asks for a refresh.
  // This serial is never reset, so the newest load within the current scope is
  // the only one allowed to publish data or an error.
  const loadSerialRef = useRef(0);
  const [scopedDaemonId, setScopedDaemonId] = useState(connection.daemonId);
  if (scopedDaemonId !== connection.daemonId) {
    setScopedDaemonId(connection.daemonId);
    scopeRef.current += 1;
    setStatus(null);
    setProposals([]);
    setError(null);
    setBusy(0);
  }
  // Frozen for this render so each `load`/`act`/`run` callback OWNS the epoch it
  // was created under. The fence compares this immutable copy to the live
  // `scopeRef.current`; capturing at render (not at invocation) is what stops a
  // stale callback that is re-entered later — e.g. an old `act` calling its own
  // old `load` after an A→B→A round trip — from re-reading the current epoch and
  // publishing as though it were still current.
  const scope = scopeRef.current;

  const load = useCallback(async () => {
    // A stale callback still makes its request so its operation can complete
    // normally, but it must not advance the current scope's load generation.
    const loadSerial = scopeRef.current === scope ? ++loadSerialRef.current : undefined;
    const canPublish = () =>
      scopeRef.current === scope && loadSerial !== undefined && loadSerialRef.current === loadSerial;
    try {
      const [nextStatus, nextProposals] = await Promise.all([
        fetchLearningStatus(connection),
        fetchLearningProposals(connection),
      ]);
      if (!canPublish()) return;
      setStatus(nextStatus);
      setProposals(nextProposals);
      setError(null);
    } catch (reason) {
      if (!canPublish()) return;
      setError(learningErrorMessage(reason));
    }
  }, [connection, scope]);
  useEffect(() => {
    void load();
  }, [load]);
  const act = useCallback(
    async (id: string, action: LearningActionRequest) => {
      setBusy(count => count + 1);
      try {
        await actOnLearningProposal(connection, id, action);
        await load();
      } catch (reason) {
        if (scopeRef.current === scope) setError(learningErrorMessage(reason));
      } finally {
        if (scopeRef.current === scope) setBusy(count => Math.max(0, count - 1));
      }
    },
    [connection, load, scope],
  );
  const run = useCallback(async () => {
    setBusy(count => count + 1);
    try {
      await runLearningScan(connection, true);
      await load();
    } catch (reason) {
      if (scopeRef.current === scope) setError(learningErrorMessage(reason));
    } finally {
      if (scopeRef.current === scope) setBusy(count => Math.max(0, count - 1));
    }
  }, [connection, load, scope]);
  return (
    <LearningReview
      connection={connection}
      status={status}
      proposals={proposals}
      error={error}
      busy={busy > 0}
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
        <LearningHeader
          status={status}
          failed={error !== null}
          busy={busy}
          // ALWAYS true, and the reason is structural rather than lax. The
          // source page gated these controls on a module-global `HAS_TOKEN`
          // because the bundle was served by the daemon it talked to and might
          // have been handed no token at all. Here a page cannot render without
          // a `DaemonConnection`, and `daemonConnection` refuses an empty
          // `deviceToken` — so a rendered learning page is an authenticated one
          // by construction, and there is no reachable read-only mode to model.
          // A per-device capability grant would change that; nothing issues one
          // today, and inventing a permanently-`true` flag to carry would be a
          // lie about a check that is not happening.
          canRun
          now={now}
          onRunNow={onRun}
        />
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
            <ProposalGroup
              label=""
              proposals={group('weak')}
              busy={busy}
              onAction={onAction}
              connection={connection}
              muted
            />
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

function ProposalGroup({
  label,
  proposals,
  busy,
  onAction,
  connection,
  accepted = false,
  muted = false,
}: {
  readonly label: string;
  readonly proposals: readonly ProposalView[];
  readonly busy: boolean;
  readonly onAction: LearningReviewProps['onAction'];
  readonly connection: DaemonConnection;
  readonly accepted?: boolean;
  readonly muted?: boolean;
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
          muted={muted}
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
  muted = false,
}: {
  readonly proposal: ProposalView;
  readonly busy: boolean;
  readonly onAction: LearningReviewProps['onAction'];
  readonly connection: DaemonConnection;
  readonly accepted: boolean;
  readonly muted?: boolean;
}) {
  const touchAffected = useTouchAffected();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(proposal.ruleText);
  const [copied, setCopied] = useState<'rule' | 'patch' | null>(null);
  const [patchError, setPatchError] = useState<string | null>(null);
  const editFieldRef = useRef<HTMLTextAreaElement | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const strength = learningStrength(proposal.occurrences);

  useEffect(
    () => () => {
      if (copiedTimer.current !== undefined) clearTimeout(copiedTimer.current);
    },
    [],
  );

  // Preserve the source page's desktop editing flow without the page-load
  // autofocus attribute. Touch devices intentionally keep focus put so opening
  // Edit does not cover the proposal with a software keyboard.
  useEffect(() => {
    if (editing && !touchAffected) editFieldRef.current?.focus();
  }, [editing, touchAffected]);

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
    <article
      className={cn('kt-panel flex flex-col gap-2 p-3', muted && 'opacity-80')}
      aria-label={`Learning proposal ${proposal.title}`}
    >
      <div className="flex flex-wrap items-start gap-2">
        <span
          // The count IS the argument for the rule, so a strong one is set in
          // heavier type as well as a different tone — colour alone would carry
          // the whole distinction for a reader who cannot separate the two.
          className={cn('kt-badge shrink-0', strength === 'strong' && 'font-semibold')}
          data-tone={strength === 'strong' ? 'accent' : strength === 'weak' ? 'pend' : 'ok'}
          title={`${proposal.occurrences} distinct session${proposal.occurrences === 1 ? '' : 's'}`}
        >
          {proposal.occurrences}×
        </span>
        <span className="mono text-meta text-faint" title="distinct repos this was seen in">
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
          ref={editFieldRef}
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
                  {evidence.teammate ? ` · ${displayCallsign(evidence.teammate)}` : ''} · {evidence.repo} ·{' '}
                  {absoluteTime(evidence.at)}
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
