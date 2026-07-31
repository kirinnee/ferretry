import { useEffect, useRef, useState } from 'react';
import { transcriptIsFollowing, type TranscriptEntry } from '../lib/session-screens.ts';
import { TranscriptRow } from './transcript-row.tsx';

export interface TranscriptProps {
  readonly daemonId: string;
  readonly sessionId: string;
  readonly entries: readonly TranscriptEntry[];
  readonly busy?: boolean;
  readonly label?: string;
}

type ScrollPort = { scrollHeight: number; scrollTop: number; clientHeight: number };

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

  // These deps are the TRIGGER, not inputs. The body reads only refs, so the rule sees them as
  // unnecessary — but dropping them stops the viewport following new entries, which is the entire
  // purpose of the effect. Re-running on a daemon or session change also resets the scroll for the
  // newly shown transcript.
  // biome-ignore lint/correctness/useExhaustiveDependencies: trigger deps, see comment above
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
          <TranscriptRow entry={entry} key={entry.id} />
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
