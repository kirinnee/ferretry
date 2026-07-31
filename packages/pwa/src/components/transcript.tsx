import { useEffect, useRef, useState } from 'react';
import type { TranscriptEntry } from './session-screen-types.ts';

export interface TranscriptProps {
  readonly daemonId: string;
  readonly sessionId: string;
  readonly entries: readonly TranscriptEntry[];
  readonly busy?: boolean;
  readonly label?: string;
}

const FOLLOW_THRESHOLD_PX = 24;
type ScrollPort = { scrollHeight: number; scrollTop: number; clientHeight: number };

/** True only at the bottom; readers who scroll away are never pulled back. */
export const transcriptIsFollowing = (element: ScrollPort): boolean =>
  element.scrollHeight - element.clientHeight - element.scrollTop <= FOLLOW_THRESHOLD_PX;

/**
 * One scroll controller for transcript content. Its identity includes both
 * daemon and session so a same-named session cannot retain another daemon's
 * scroll/follow state when its host switches connection.
 */
export function Transcript({ daemonId, sessionId, entries, busy = false, label = 'Transcript' }: TranscriptProps) {
  const viewport = useRef<ScrollPort | null>(null);
  const following = useRef(true);
  const [newCount, setNewCount] = useState(0);
  const previousLength = useRef(entries.length);

  useEffect(() => {
    const element = viewport.current;
    if (!element || !following.current) return;
    element.scrollTop = element.scrollHeight;
  }, [daemonId, sessionId, entries, busy]);

  useEffect(() => {
    if (entries.length <= previousLength.current) {
      previousLength.current = entries.length;
      return;
    }
    if (following.current) setNewCount(0);
    else setNewCount(count => count + entries.length - previousLength.current);
    previousLength.current = entries.length;
  }, [entries.length]);

  const jumpToLatest = () => {
    const element = viewport.current;
    if (!element) return;
    following.current = true;
    setNewCount(0);
    element.scrollTop = element.scrollHeight;
  };

  return (
    <section aria-label={label} className="fy-transcript-shell" data-daemon-id={daemonId} data-session-id={sessionId}>
      <div
        className="fy-transcript"
        onScroll={() => {
          const element = viewport.current;
          if (!element) return;
          following.current = transcriptIsFollowing(element);
          if (following.current) setNewCount(0);
        }}
        ref={element => {
          viewport.current = element as unknown as ScrollPort | null;
        }}
        role="log"
        aria-live="polite"
      >
        {entries.map(entry => (
          <article className={`fy-message fy-message-${entry.kind}`} key={entry.id}>
            <header>{entry.label ?? entry.kind}</header>
            <p>{entry.text}</p>
            {entry.at ? (
              <time dateTime={new Date(entry.at).toISOString()}>{new Date(entry.at).toLocaleTimeString()}</time>
            ) : null}
          </article>
        ))}
        {busy ? <p className="fy-thinking">Working…</p> : null}
      </div>
      {newCount > 0 ? (
        <button className="fy-jump-latest" onClick={jumpToLatest} type="button">
          {newCount} new {newCount === 1 ? 'message' : 'messages'} · Jump to latest
        </button>
      ) : null}
    </section>
  );
}
