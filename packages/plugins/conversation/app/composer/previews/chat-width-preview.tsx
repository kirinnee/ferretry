/**
 * The conversation-width strip: the pane, and the text column inside it easing to the chosen width while three lines
 * write themselves across it ONCE, then rest written. Opening the tab plays nothing; choosing a width plays it once
 * (`data-cvp-write="play"`, keyed by how many choices have been made so each one restarts it). With motion off the
 * column still moves with no easing and the lines sit written. Like every other preview a play holds still
 * (`data-cvp-motion="paused"`) while the tab is hidden or the strip is off-screen.
 */

import { cn, usePreviewPlaying } from '@ferretry/app';
import { useRef, useState } from 'react';
import type { ChatWidthPreference as ChatWidth } from '@ferretry/app';
import { useMotionAllowed } from '@ferretry/app/ui';
import './previews.css';

const COLUMN_WIDTH_CLASS: Readonly<Record<ChatWidth, string>> = {
  full: 'w-full',
  balanced: 'w-3/4',
  readable: 'w-5/12',
};

export function ChatWidthPreview({ value }: { readonly value: ChatWidth }) {
  const strip = useRef<HTMLDivElement | null>(null);
  const motion = useMotionAllowed();
  const playing = usePreviewPlaying(strip);
  // How many times a width has been chosen since the strip mounted: 0 rests, and each choice restarts the one write.
  const [seen, setSeen] = useState(value);
  const [plays, setPlays] = useState(0);
  if (seen !== value) {
    setSeen(value);
    setPlays(plays + 1);
  }
  return (
    <div
      ref={strip}
      aria-hidden="true"
      data-cvp-motion={!motion ? 'still' : playing ? 'on' : 'paused'}
      data-cvp-write={plays > 0 ? 'play' : 'rest'}
      className="mt-2 flex h-14 w-full items-center justify-center rounded-control bg-surface px-2"
    >
      <div
        data-chat-width-preview={value}
        className={cn(
          'flex h-10 flex-col justify-center gap-1.5 rounded-sm border border-accent/50 bg-accent-soft px-2',
          motion && 'transition-[width] duration-500 ease-out',
          COLUMN_WIDTH_CLASS[value],
        )}
      >
        <span key={`a${plays}`} className="fy-cvp-write" />
        <span key={`b${plays}`} className="fy-cvp-write" />
        <span key={`c${plays}`} className="fy-cvp-write" />
      </div>
    </div>
  );
}
