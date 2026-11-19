/**
 * The conversation-width strip: the pane, and the text column inside it easing to the chosen width while three lines
 * write themselves across it. With motion off the column still moves with no easing and the lines sit written.
 */

import { cn } from '@ferretry/app';
import type { ChatWidthPreference as ChatWidth } from '@ferretry/app';
import { useMotionAllowed } from '@ferretry/app/ui';
import './previews.css';

const COLUMN_WIDTH_CLASS: Readonly<Record<ChatWidth, string>> = {
  full: 'w-full',
  balanced: 'w-3/4',
  readable: 'w-5/12',
};

export function ChatWidthPreview({ value }: { readonly value: ChatWidth }) {
  const motion = useMotionAllowed();
  return (
    <div
      aria-hidden="true"
      data-cvp-motion={motion ? 'on' : 'still'}
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
        <span className="fy-cvp-write" />
        <span className="fy-cvp-write" />
        <span className="fy-cvp-write" />
      </div>
    </div>
  );
}
