import { LoaderCircle } from 'lucide-react';
import type { TranscriptHistoryStatus } from '../lib/transcript-history.ts';

/** What the top of the transcript offers, and the one way to ask for more of it. */
export interface TranscriptHistoryControl {
  readonly status: TranscriptHistoryStatus;
  /** Load the page just older than the oldest message on screen. A call while one loads is that load. */
  readonly loadOlder: () => void;
}

/**
 * How near the top of the transcript, in pixels, a reader is when the next older page is read — about
 * two screens, so on a phone or a desktop the page is usually in before the reader reaches it.
 */
export const LOAD_OLDER_WITHIN_PX = 1_200;

/** Whether the reader is near enough the top to read the next page now. A short transcript always is. */
export const wantsOlder = (status: TranscriptHistoryStatus, scrollTop: number): boolean =>
  status === 'more' && scrollTop <= LOAD_OLDER_WITHIN_PX;

/**
 * The row above the first message: loading older ones, the start of the conversation, or a retry.
 *
 * Older messages load by themselves as the reader nears the top; the button is the same load for a
 * keyboard, a screen reader, or a reader who got there faster than the page. The row is one height in
 * every state — including before the first read says which, when it is empty — so a state arriving never
 * moves the messages under the reader, and a reading position kept across a reload lands where it was.
 */
export function TranscriptHistoryRow({ control }: { readonly control: TranscriptHistoryControl }) {
  const { status, loadOlder } = control;
  if (status === 'unavailable')
    return <div aria-hidden="true" className="fy-transcript-history" data-history={status} />;
  return (
    <div className="fy-transcript-history" data-history={status}>
      {status === 'loading' ? (
        <span className="fy-transcript-history__note" role="status">
          <LoaderCircle aria-hidden="true" className="animate-spin" size={13} />
          Loading older messages…
        </span>
      ) : status === 'start' ? (
        <span className="fy-transcript-history__note">Beginning of the conversation</span>
      ) : (
        <button className="fy-transcript-history__button" onClick={loadOlder} type="button">
          {status === 'error' ? 'Couldn’t load older messages — try again' : 'Load older messages'}
        </button>
      )}
    </div>
  );
}
