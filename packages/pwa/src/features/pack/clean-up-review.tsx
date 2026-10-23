/**
 * A CLEAN-UP RUN AND ITS REVIEW (docs/pack-mode.md § Clean up): the run while it goes — its name, runtime
 * and time so far, with a link to its session — and the rewrite once it arrives, as a before/after word
 * diff and the notes the daemon checked it with, to accept or discard.
 *
 * The diff is `diffText` from the protocol, the same one `fy guide clean-up` prints, so the app and the
 * terminal can never show a person two different changes. A removed run is struck through and an added one
 * underlined, each also named for a screen reader, so colour is never the only signal.
 */

import { diffText, type PackCleanUpJob, type PackCleanUpNote, type PackCleanUpSuggestion } from '@ferretry/protocol';
import { useId, useMemo } from 'react';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { formatElapsedSeconds } from '../../lib/live-counter.ts';
import { daemonSessionPath } from '../../lib/pages/routes.ts';
import { useOptionalRouter } from '../../lib/router.tsx';
import { absoluteTime } from '../../lib/session-screens.ts';
import { Badge, type BadgeTone, Button } from '../../shell/primitives.tsx';
import { RouteLink } from '../../shell/route-link.tsx';

const JOB_BADGE: Readonly<Record<PackCleanUpJob['status'], { readonly tone: BadgeTone; readonly label: string }>> = {
  running: { tone: 'accent', label: 'Running' },
  suggested: { tone: 'ok', label: 'Rewrite ready' },
  failed: { tone: 'err', label: 'Failed' },
};

const NOTE_BADGE: Readonly<Record<PackCleanUpNote['kind'], { readonly tone: BadgeTone; readonly label: string }>> = {
  unknown_model: { tone: 'err', label: 'Unknown model' },
  absent_model: { tone: 'warn', label: 'Not on this machine' },
  cut: { tone: 'warn', label: 'Cut to fit' },
  suggestion: { tone: 'accent', label: 'Suggestion' },
};

function SessionLink({ connection, job }: { readonly connection: DaemonConnection; readonly job: PackCleanUpJob }) {
  const router = useOptionalRouter();
  return (
    <RouteLink
      to={daemonSessionPath(connection.daemonId, job.session)}
      {...(router ? { onNavigate: router.navigate } : {})}
      className="inline-flex min-h-[44px] items-center self-start text-ui text-accent underline"
      data-clean-up-session=""
    >
      Open the clean-up’s session
    </RouteLink>
  );
}

/** The run as it stands: going (with its time so far), done, or failed with why. */
export function CleanUpJobCard({
  connection,
  job,
  nowMs,
  readError,
}: {
  readonly connection: DaemonConnection;
  readonly job: PackCleanUpJob;
  readonly nowMs: number;
  readonly readError: string | null;
}) {
  const badge = JOB_BADGE[job.status];
  const started = Date.parse(job.startedAt);
  return (
    <div
      className="flex min-w-0 flex-col gap-1 rounded-control border border-border-strong bg-surface-2 p-3"
      data-clean-up-job={job.status}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <Badge tone={badge.tone}>{badge.label}</Badge>
        <span className="min-w-0 break-all text-ui font-semibold" data-clean-up-name="">
          {job.name}
        </span>
      </div>
      <p className="m-0 min-w-0 break-words text-meta leading-base text-muted">
        On <span className="mono">{job.runtime}</span>
        {job.model === undefined ? (
          ''
        ) : (
          <>
            {' '}
            · <span className="mono">{job.model}</span>
          </>
        )}
        {job.status === 'running'
          ? ` · running for ${formatElapsedSeconds((nowMs - started) / 1000)}`
          : ` · started ${absoluteTime(job.startedAt)}`}
      </p>
      {job.status === 'failed' ? (
        <p role="alert" className="m-0 break-words text-meta leading-base text-err" data-clean-up-message="">
          {job.message ?? 'The clean-up stopped without a rewrite.'}
        </p>
      ) : null}
      {readError === null ? null : (
        <p role="status" className="m-0 break-words text-meta leading-base text-warn">
          Could not read the clean-up just now ({readError}) — trying again.
        </p>
      )}
      <SessionLink connection={connection} job={job} />
    </div>
  );
}

/** The before/after word diff: what the rewrite removed, struck through, and what it added, underlined. */
function PromptDiff({ before, after }: { readonly before: string; readonly after: string }) {
  const parts = useMemo(() => diffText(before, after), [before, after]);
  return (
    <p
      className="m-0 min-w-0 whitespace-pre-wrap break-words rounded-control border border-border-soft bg-surface p-3 text-ui leading-base"
      data-clean-up-diff=""
    >
      {parts.map((part, index) =>
        part.kind === 'same' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts are a fixed rendering of one diff
          <span key={index}>{part.text}</span>
        ) : part.kind === 'removed' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts are a fixed rendering of one diff
          <del key={index} data-diff="removed" className="rounded-sm bg-err-bg text-err decoration-2">
            <span className="sr-only">[removed: </span>
            {part.text}
            <span className="sr-only">]</span>
          </del>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts are a fixed rendering of one diff
          <ins key={index} data-diff="added" className="rounded-sm bg-ok-bg text-ok underline decoration-2">
            <span className="sr-only">[added: </span>
            {part.text}
            <span className="sr-only">]</span>
          </ins>
        ),
      )}
    </p>
  );
}

/** The rewrite to review: who made it, the diff, the notes, and Accept / Edit / Discard. */
export function CleanUpReview({
  suggestion,
  busy,
  onAccept,
  onEdit,
  onDiscard,
}: {
  readonly suggestion: PackCleanUpSuggestion;
  readonly busy: boolean;
  readonly onAccept: () => void;
  readonly onEdit: () => void;
  readonly onDiscard: () => void;
}) {
  const headingId = useId();
  const unchanged = suggestion.before.trim() === suggestion.after.trim();
  return (
    <section
      className="flex min-w-0 flex-col gap-3 rounded-control border border-accent bg-surface-2 p-3"
      aria-labelledby={headingId}
      data-clean-up-review=""
    >
      <div className="min-w-0">
        <h4 id={headingId} className="m-0 text-ui font-semibold">
          Review the clean-up
        </h4>
        <p className="m-0 mt-1 break-words text-meta leading-base text-muted">
          Rewritten by <span className="mono">{suggestion.suggested.by}</span> via{' '}
          <span className="mono">{suggestion.suggested.via}</span>, {absoluteTime(suggestion.suggested.at)}. Nothing is
          saved until you accept it.
        </p>
      </div>
      <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-muted" aria-hidden="true">
        <span>
          <del className="rounded-sm bg-err-bg px-1 text-err">struck through</del> removed
        </span>
        <span>
          <ins className="rounded-sm bg-ok-bg px-1 text-ok underline">underlined</ins> added
        </span>
      </p>
      {unchanged ? (
        <p className="m-0 text-meta text-muted" data-clean-up-unchanged="">
          The rewrite says exactly what you wrote.
        </p>
      ) : null}
      <PromptDiff before={suggestion.before} after={suggestion.after} />
      {suggestion.notes.length === 0 ? null : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Notes on the rewrite" data-clean-up-notes="">
          {suggestion.notes.map((note, index) => {
            const badge = NOTE_BADGE[note.kind];
            return (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: notes are a fixed list the daemon wrote
                key={index}
                className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1"
                data-clean-up-note={note.kind}
              >
                <Badge tone={badge.tone} className="shrink-0">
                  {badge.label}
                </Badge>
                {note.model === undefined ? null : (
                  <span className="mono min-w-0 break-all text-meta font-semibold">{note.model}</span>
                )}
                <span className="min-w-0 flex-1 basis-[200px] break-words text-meta leading-base">{note.message}</span>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" className="min-h-[44px]" disabled={busy} onClick={onAccept} data-review="accept">
          Accept
        </Button>
        <Button className="min-h-[44px]" disabled={busy} onClick={onEdit} data-review="edit">
          Edit first
        </Button>
        <Button variant="ghost" className="min-h-[44px]" disabled={busy} onClick={onDiscard} data-review="discard">
          Discard
        </Button>
      </div>
    </section>
  );
}
