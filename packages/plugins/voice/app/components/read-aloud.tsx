import { Square, TriangleAlert, Volume2 } from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef } from 'react';
import { type RowReadAloud, useReadAloud } from '../hooks/use-read-aloud.ts';
import { captionScrollTop } from '../lib/voice-chat/caption-scroll.ts';
import { speakableSegments } from '../lib/voice-chat/speakable.ts';

/**
 * READ ALOUD, ON ONE ASSISTANT MESSAGE (F137 slice 1; `docs/voice.md` › Read aloud).
 *
 * A button with an icon AND words — "Read aloud", and "Stop" while this message is the one being read —
 * so it is never an emoji or colour alone. The same element changes its label, so keyboard focus stays on
 * it through Stop. While reading, the sentence being said is highlighted in a captions block under the
 * message and scrolled into view; the page reads along. The captions are hidden from a screen reader
 * (they repeat the message and the voice), and a polite live region says only "Reading", "Stopped",
 * "Finished", "Couldn't read this" or "No on-device voice, reading unavailable" — never the reply itself.
 *
 * A voice that sends the text away says so in a warning (icon, words, full-size text) next to the button
 * BEFORE it is pressed as well as while reading. The captions box shows whole lines only: it grows to a
 * fixed number of lines and then scrolls a line at a time.
 *
 * Nothing is shown where the device has no speech, or where the message has nothing to say aloud.
 * Reduced motion: no smooth scrolling and no animated highlight.
 */
export function ReadAloudControl({ entryId, text }: { readonly entryId: string; readonly text: string }) {
  const row = useReadAloud(entryId);
  const speakable = useMemo(() => speakableSegments(text).segments.length > 0, [text]);
  if (!row.supported || !speakable) return null;
  return <ReadAloudRow row={row} text={text} />;
}

const STATUS_WORDS = {
  idle: '',
  reading: 'Reading',
  stopped: 'Stopped',
  finished: 'Finished',
  failed: "Couldn't read this aloud",
  unavailable: 'No on-device voice, reading unavailable',
} as const;

function ReadAloudRow({ row, text }: { readonly row: RowReadAloud; readonly text: string }) {
  const { state, reading } = row;
  const words = STATUS_WORDS[state.status];
  const warning = row.voiceNote();
  return (
    <div className="fy-read-aloud" data-read-state={state.status}>
      <div className="fy-read-aloud-bar">
        <button
          className="fy-read-aloud-button"
          data-reading={reading ? '' : undefined}
          onClick={() => (reading ? row.stop() : row.read(text))}
          type="button"
        >
          {reading ? <Square aria-hidden="true" size={15} /> : <Volume2 aria-hidden="true" size={16} />}
          <span>{reading ? 'Stop' : 'Read aloud'}</span>
        </button>
        <span className="fy-read-aloud-state" aria-hidden="true">
          {words}
        </span>
        <span aria-live="polite" className="sr-only" role="status">
          {words}
        </span>
      </div>
      {warning !== null ? (
        <div className="fy-read-aloud-note" data-voice-warning>
          <TriangleAlert aria-hidden="true" size={18} />
          <span>{warning}</span>
        </div>
      ) : null}
      {reading ? <ReadAloudCaptions current={state.current} segments={state.segments} /> : null}
    </div>
  );
}

const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The sentences being read, the current one marked — and kept in view, a whole line at a time, as the voice moves on. */
function ReadAloudCaptions({ segments, current }: { readonly segments: readonly string[]; readonly current: number }) {
  const active = useRef<HTMLSpanElement | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the sentence moving on (`current`) is what brings the new one into view.
  useEffect(() => {
    const box = scroller.current;
    const rects = active.current?.getClientRects?.();
    const first = rects?.[0];
    const last = rects?.[rects.length - 1];
    // Not every environment can lay out (and an unmounted node has nowhere to go).
    if (box == null || first == null || last == null) return;
    const origin = box.getBoundingClientRect().top - box.scrollTop;
    const top = captionScrollTop({
      top: first.top - origin,
      bottom: last.bottom - origin,
      line: Number.parseFloat(getComputedStyle(box).lineHeight),
      viewport: box.clientHeight,
      content: box.scrollHeight,
      scrollTop: box.scrollTop,
    });
    if (top !== null) box.scrollTo?.({ top, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }, [current]);
  return (
    <div aria-hidden="true" className="fy-read-captions" data-read-captions>
      <div className="fy-read-captions-scroll" ref={scroller}>
        <div className="fy-read-captions-text">
          {segments.map((segment, index) => (
            // The sentences are fixed for one reading, so their position is their identity.
            // biome-ignore lint/suspicious/noArrayIndexKey: see above
            <Fragment key={index}>
              <span
                className="fy-read-caption"
                data-current={index === current ? '' : undefined}
                ref={index === current ? active : undefined}
              >
                {segment.trim()}
              </span>{' '}
            </Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}
