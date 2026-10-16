/**
 * ONE LESSON: a row that opens in place to its rule, its type, its evidence and the acts its state
 * allows. Apply lives here too, because a reader decides it while looking at the evidence: the preview
 * fetches the exact diff and its etag, the confirm writes exactly that, and a file that moved in between
 * is said out loud with a way to see the new diff — never written over.
 */

import type {
  LearningActionRequest,
  LearningApplyPreview,
  ProposalCategory,
  ProposalView,
  SessionView,
} from '@ferretry/protocol';
import { Check, ChevronRight, FileText, Pencil, RotateCcw, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { cn } from '../../lib/class-names.ts';
import type { DaemonId } from '../../lib/daemon-connection.ts';
import { isApplyConflict, learningErrorMessage } from '../../lib/learning-api.ts';
import { daemonSessionPath } from '../../lib/pages/routes.ts';
import { Badge, Button } from '../../shell/primitives.tsx';
import { RouteLink } from '../../shell/route-link.tsx';
import { ApplyDiff } from './apply-diff.tsx';
import {
  basename,
  lessonSourceLabel,
  lessonTime,
  pickedSentence,
  STRONG_LESSON_COUNT,
  sessionName,
  strengthLabel,
  typeLabel,
} from './learning-model.ts';
import { useTouchAffected } from './use-touch-affected.ts';

export interface LessonActions {
  /** A verdict; resolves once the hub holds the daemon's answer, throws with the daemon's refusal. */
  readonly act: (id: string, action: LearningActionRequest) => Promise<void>;
  readonly preview: (id: string) => Promise<LearningApplyPreview>;
  /** Writes the previewed diff; the hub moves the lesson to Applied and says where it went. */
  readonly apply: (id: string, preview: LearningApplyPreview) => Promise<void>;
}

export interface LessonRowProps extends LessonActions {
  readonly proposal: ProposalView;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly sessions: ReadonlyMap<string, SessionView>;
  readonly daemonId: DaemonId;
  readonly onNavigate?: (to: string) => void;
  /** The zone times are shown in; the reader's own when absent. */
  readonly timeZone?: string;
}

type ApplyStep =
  | { readonly step: 'idle' }
  | { readonly step: 'loading' }
  | { readonly step: 'preview'; readonly preview: LearningApplyPreview }
  | { readonly step: 'writing'; readonly preview: LearningApplyPreview }
  | { readonly step: 'conflict'; readonly path: string };

export function LessonChips({
  proposal,
  sessions,
}: {
  readonly proposal: ProposalView;
  readonly sessions: ReadonlyMap<string, SessionView>;
}) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <Badge
        tone={proposal.count >= STRONG_LESSON_COUNT ? 'ok' : 'pend'}
        title={`Filed ${proposal.count} time${proposal.count === 1 ? '' : 's'}`}
        data-lesson-chip="strength"
      >
        {strengthLabel(proposal.count)}
      </Badge>
      <Badge
        tone={proposal.category === 'global' ? 'warn' : 'ok'}
        title={proposal.category === 'global' ? 'All ferrets: the global instructions' : 'This project’s instructions'}
        data-lesson-chip="type"
      >
        {typeLabel(proposal.category, proposal.project)}
      </Badge>
      <Badge tone="accent" data-lesson-chip="source">
        {lessonSourceLabel(proposal, sessions)}
      </Badge>
    </span>
  );
}

export function LessonRow({
  proposal,
  open,
  onToggle,
  sessions,
  daemonId,
  onNavigate,
  timeZone,
  act,
  preview,
  apply,
}: LessonRowProps) {
  const bodyId = useId();
  const touchAffected = useTouchAffected();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(proposal.ruleText);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applyStep, setApplyStep] = useState<ApplyStep>({ step: 'idle' });
  const ruleRef = useRef<HTMLTextAreaElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const editable = proposal.state === 'pending' || proposal.state === 'accepted';

  // A touch device keeps focus put, so opening Edit does not throw a keyboard over the evidence.
  useEffect(() => {
    if (editing && !touchAffected) ruleRef.current?.focus();
  }, [editing, touchAffected]);
  // The confirm is the next thing to press once the diff is on screen.
  const previewShown = applyStep.step === 'preview';
  useEffect(() => {
    if (previewShown) confirmRef.current?.focus();
  }, [previewShown]);

  const run = async (action: LearningActionRequest): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await act(proposal.id, action);
      return true;
    } catch (reason) {
      setError(learningErrorMessage(reason));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async () => {
    if (await run({ action: 'edit', ruleText: draft.trim() })) setEditing(false);
  };

  const startApply = async () => {
    setError(null);
    setApplyStep({ step: 'loading' });
    try {
      setApplyStep({ step: 'preview', preview: await preview(proposal.id) });
    } catch (reason) {
      setApplyStep({ step: 'idle' });
      setError(learningErrorMessage(reason));
    }
  };

  const confirmApply = async (shown: LearningApplyPreview) => {
    setError(null);
    setApplyStep({ step: 'writing', preview: shown });
    try {
      await apply(proposal.id, shown);
      setApplyStep({ step: 'idle' });
    } catch (reason) {
      if (isApplyConflict(reason)) setApplyStep({ step: 'conflict', path: shown.path });
      else {
        setApplyStep({ step: 'preview', preview: shown });
        setError(learningErrorMessage(reason));
      }
    }
  };

  const changeType = (category: ProposalCategory) => {
    if (category !== proposal.category) void run({ action: 'categorize', category });
  };

  const shownPreview = applyStep.step === 'preview' || applyStep.step === 'writing' ? applyStep.preview : null;

  return (
    <li className="kt-panel overflow-hidden p-0" data-lesson={proposal.id}>
      <button
        type="button"
        className="flex min-h-[44px] w-full items-start gap-2 px-3 py-2.5 text-left hover:bg-surface-2"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={onToggle}
      >
        <ChevronRight
          size={15}
          aria-hidden="true"
          className={cn('mt-0.5 shrink-0 text-faint transition-transform', open && 'rotate-90')}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-1.5 sm:flex-row sm:items-start sm:gap-3">
          <span className="min-w-0 flex-1 break-words text-ui text-fg">{proposal.ruleText}</span>
          <LessonChips proposal={proposal} sessions={sessions} />
        </span>
      </button>
      {open && (
        <div id={bodyId} className="flex flex-col gap-3 border-t border-border-soft px-3 py-3">
          <label className="flex flex-col gap-1">
            <span className="text-meta font-semibold text-muted">Rule{editing ? ' (editing)' : ''}</span>
            <textarea
              ref={ruleRef}
              className="kt-input min-h-[64px] resize-y"
              rows={2}
              value={editing ? draft : proposal.ruleText}
              readOnly={!editing}
              aria-readonly={!editing}
              onChange={event => setDraft(event.target.value)}
            />
          </label>
          {editable && (
            <fieldset className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0">
              <legend className="mb-1 p-0 text-meta font-semibold text-muted">Type</legend>
              <p className="m-0 text-meta text-faint">{pickedSentence(proposal)}</p>
              <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Lesson type">
                {(['global', 'repo'] as const).map(category => (
                  <label
                    key={category}
                    className={cn(
                      'flex min-h-[44px] cursor-pointer items-center gap-2 rounded-control border px-3 text-ui',
                      proposal.category === category ? 'border-accent bg-accent-soft text-accent' : 'border-border',
                    )}
                  >
                    <input
                      type="radio"
                      name={`${bodyId}-type`}
                      value={category}
                      checked={proposal.category === category}
                      disabled={busy}
                      onChange={() => changeType(category)}
                    />
                    {category === 'global'
                      ? 'Global · all ferrets'
                      : `Repo · ${proposal.project === undefined ? 'this project' : basename(proposal.project)}`}
                  </label>
                ))}
              </div>
              <p className="m-0 text-meta text-faint">
                Writes to <span className="mono break-all text-fg-soft">{proposal.target.path}</span>
              </p>
            </fieldset>
          )}
          <section aria-label="Evidence" className="flex flex-col gap-1.5">
            <h3 className="m-0 text-meta font-semibold text-muted">
              Evidence ({proposal.evidence.length}) — attached by the daemon
            </h3>
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {proposal.evidence.map(evidence => (
                <li key={evidence.observationId}>
                  <blockquote className="m-0 border-l-2 border-accent-border pl-3">
                    <p className="m-0 break-words text-ui text-fg-soft">“{evidence.quote}”</p>
                    <footer className="flex flex-wrap items-center gap-x-1.5 text-meta text-faint">
                      <RouteLink
                        className="inline-flex min-h-[44px] items-center text-accent underline-offset-2 hover:underline sm:min-h-0"
                        to={daemonSessionPath(daemonId, evidence.sessionId)}
                        {...(onNavigate === undefined ? {} : { onNavigate })}
                      >
                        {sessionName(evidence.sessionId, sessions, evidence.teammate)}
                      </RouteLink>
                      {evidence.turn === undefined ? null : <span>· turn {evidence.turn}</span>}
                      <span>· {lessonTime(evidence.at, timeZone)}</span>
                    </footer>
                  </blockquote>
                </li>
              ))}
            </ul>
          </section>
          {applyStep.step === 'loading' && (
            <p role="status" className="m-0 text-meta text-muted">
              Reading what Ferretry would write…
            </p>
          )}
          {shownPreview !== null && (
            <section aria-label="Apply preview" className="flex min-w-0 flex-col gap-2">
              <h3 className="m-0 text-meta font-semibold text-muted">Preview: what Ferretry will write</h3>
              <p className="m-0 text-meta text-faint">
                {shownPreview.exists ? 'Changes' : 'Creates'}{' '}
                <span className="mono break-all text-fg-soft">{shownPreview.path}</span>
              </p>
              {shownPreview.notes.length > 0 && (
                <ul className="m-0 flex list-disc flex-col gap-0.5 pl-5 text-meta text-muted">
                  {shownPreview.notes.map(note => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              )}
              <ApplyDiff path={shownPreview.path} diff={shownPreview.diff} />
              <div className="flex flex-wrap gap-2">
                <Button
                  ref={confirmRef}
                  size="sm"
                  variant="primary"
                  className="min-h-[44px] items-center gap-1.5"
                  disabled={applyStep.step === 'writing'}
                  onClick={() => void confirmApply(shownPreview)}
                >
                  <Check size={14} aria-hidden="true" />
                  {applyStep.step === 'writing' ? 'Writing…' : `Write to ${basename(shownPreview.path)}`}
                </Button>
                <Button
                  size="sm"
                  className="min-h-[44px]"
                  disabled={applyStep.step === 'writing'}
                  onClick={() => setApplyStep({ step: 'idle' })}
                >
                  Cancel
                </Button>
              </div>
            </section>
          )}
          {applyStep.step === 'conflict' && (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-2 rounded-control border border-warn-border bg-warn-bg px-3 py-2 text-meta text-warn"
            >
              <span className="min-w-0 flex-1">
                {basename(applyStep.path)} changed since this preview, so nothing was written.
              </span>
              <Button size="sm" className="min-h-[44px]" onClick={() => void startApply()}>
                Show the new diff
              </Button>
            </div>
          )}
          {error !== null && (
            <p
              role="alert"
              className="m-0 rounded-control border border-err-border bg-err-bg px-3 py-2 text-meta text-err"
            >
              {error}
            </p>
          )}
          {/* While Apply is reading or showing its diff, its own two buttons are the only acts. */}
          {(applyStep.step === 'idle' || applyStep.step === 'conflict') && (
            <LessonActionsBar
              proposal={proposal}
              editing={editing}
              busy={busy}
              timeZone={timeZone}
              draftEmpty={draft.trim() === ''}
              onAccept={() => void run({ action: 'accept' })}
              onReject={() => void run({ action: 'reject' })}
              onReopen={() => void run({ action: 'reopen' })}
              onEdit={() => {
                setDraft(proposal.ruleText);
                setEditing(true);
              }}
              onSaveEdit={() => void saveEdit()}
              onCancelEdit={() => setEditing(false)}
              onApply={() => void startApply()}
            />
          )}
        </div>
      )}
    </li>
  );
}

function LessonActionsBar({
  proposal,
  editing,
  busy,
  timeZone,
  draftEmpty,
  onAccept,
  onReject,
  onReopen,
  onEdit,
  onSaveEdit,
  onCancelEdit,
  onApply,
}: {
  readonly proposal: ProposalView;
  readonly editing: boolean;
  readonly busy: boolean;
  readonly timeZone: string | undefined;
  readonly draftEmpty: boolean;
  readonly onAccept: () => void;
  readonly onReject: () => void;
  readonly onReopen: () => void;
  readonly onEdit: () => void;
  readonly onSaveEdit: () => void;
  readonly onCancelEdit: () => void;
  readonly onApply: () => void;
}) {
  if (proposal.state === 'applied') {
    return (
      <p className="m-0 text-meta text-muted" data-lesson-applied="">
        {proposal.applied === undefined ? (
          'Applied.'
        ) : (
          <>
            Applied to <span className="mono break-all text-fg-soft">{proposal.applied.path}</span> ·{' '}
            {lessonTime(proposal.applied.at, timeZone)}
          </>
        )}
      </p>
    );
  }
  if (proposal.state === 'rejected') {
    return (
      <p className="m-0 text-meta text-muted">Rejected. Ferretry keeps it so the same lesson is not filed again.</p>
    );
  }
  const edit = editing ? (
    <>
      <Button
        size="sm"
        variant="primary"
        className="min-h-[44px] items-center gap-1.5"
        disabled={busy || draftEmpty}
        onClick={onSaveEdit}
      >
        <Check size={14} aria-hidden="true" />
        Save edit
      </Button>
      <Button size="sm" className="min-h-[44px]" disabled={busy} onClick={onCancelEdit}>
        Cancel
      </Button>
    </>
  ) : (
    <Button size="sm" className="min-h-[44px] items-center gap-1.5" disabled={busy} onClick={onEdit}>
      <Pencil size={14} aria-hidden="true" />
      Edit
    </Button>
  );
  return (
    <div className="flex flex-wrap gap-2" data-lesson-actions={proposal.state}>
      {proposal.state === 'pending' ? (
        <>
          {!editing && (
            <Button
              size="sm"
              variant="primary"
              className="min-h-[44px] items-center gap-1.5"
              disabled={busy}
              onClick={onAccept}
            >
              <Check size={14} aria-hidden="true" />
              Accept
            </Button>
          )}
          {edit}
          {!editing && (
            <Button
              size="sm"
              variant="danger"
              className="min-h-[44px] items-center gap-1.5"
              disabled={busy}
              onClick={onReject}
            >
              <X size={14} aria-hidden="true" />
              Reject
            </Button>
          )}
        </>
      ) : (
        <>
          {!editing && (
            <Button
              size="sm"
              variant="primary"
              className="min-h-[44px] items-center gap-1.5"
              disabled={busy}
              onClick={onApply}
            >
              <FileText size={14} aria-hidden="true" />
              Apply…
            </Button>
          )}
          {edit}
          {!editing && (
            <Button
              size="sm"
              variant="ghost"
              className="min-h-[44px] items-center gap-1.5"
              disabled={busy}
              onClick={onReopen}
            >
              <RotateCcw size={14} aria-hidden="true" />
              Back to review
            </Button>
          )}
        </>
      )}
    </div>
  );
}
