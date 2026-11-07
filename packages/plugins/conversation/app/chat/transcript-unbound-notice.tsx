/**
 * The workspace's answer when the daemon can prove NO transcript is this session's own.
 *
 * That is not a passing read failure. Chat cannot fill, a turn cannot be seen to end, and no send can
 * ever be confirmed — while the agent may be working perfectly well in its terminal. Said as a bare
 * error line it read like a glitch, and the reader's only visible move was "send again", which types
 * a second copy into an agent that already has the first. So this says what is and is not known, and
 * offers the two things that can change it:
 *
 *   * CHECK AGAIN — a fresh read. The daemon discovers the transcript on demand, so one that has just
 *     been written is bound by this look.
 *   * RESTART CLI — behind a confirmation, because for a session with no proven transcript there is
 *     no conversation the daemon can name to resume: the agent comes back in a new one.
 */

import { useState } from 'react';

export interface TranscriptUnboundNoticeProps {
  readonly onCheckAgain: () => void;
  /** Absent when this viewer may not restart the session. */
  readonly onRestart?: () => Promise<void>;
}

export const TRANSCRIPT_UNBOUND_COPY =
  'Ferretry can’t find a transcript it can prove belongs to this session, so Chat stays empty and messages show as unconfirmed — even if the agent answered. The Console tab shows what the agent actually has.';

export const TRANSCRIPT_UNBOUND_RESTART_COPY =
  'Restarting starts the CLI with a transcript Ferretry can read. Its current conversation can’t be resumed, because Ferretry can’t prove which one it was.';

export function TranscriptUnboundNotice({ onCheckAgain, onRestart }: TranscriptUnboundNoticeProps) {
  const [restarting, setRestarting] = useState(false);
  const [failed, setFailed] = useState(false);

  const restart = async (): Promise<void> => {
    if (onRestart === undefined || restarting) return;
    setRestarting(true);
    setFailed(false);
    try {
      await onRestart();
    } catch {
      setFailed(true);
    } finally {
      setRestarting(false);
    }
  };

  return (
    <section
      aria-label="Transcript not found"
      className="mx-3 my-1 rounded-control border border-warn-border bg-warn-bg px-3 py-2 text-meta text-warn"
      data-transcript-unbound=""
    >
      <p className="m-0">{TRANSCRIPT_UNBOUND_COPY}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <button
          className="rounded-sm border border-warn-border px-2 py-1 font-semibold hover:bg-surface"
          onClick={onCheckAgain}
          type="button"
        >
          Check again
        </button>
        {onRestart === undefined ? null : (
          <details className="min-w-0">
            <summary className="w-fit cursor-pointer select-none rounded-sm px-1.5 py-1 font-medium hover:bg-surface">
              Restart CLI…
            </summary>
            <p className="mb-0 mt-1">{TRANSCRIPT_UNBOUND_RESTART_COPY}</p>
            <button
              className="mt-1.5 rounded-sm border border-warn-border px-2 py-1 font-semibold hover:bg-surface disabled:cursor-wait disabled:opacity-60"
              disabled={restarting}
              onClick={() => void restart()}
              type="button"
            >
              {restarting ? 'restarting…' : 'Restart'}
            </button>
          </details>
        )}
      </div>
      {failed ? (
        <p className="mb-0 mt-1.5 text-err" role="alert">
          The restart did not go through — try again from Actions › Restart CLI.
        </p>
      ) : null}
    </section>
  );
}
