/**
 * THE LIVE BUTTON: the one that starts and ends Live voice, next to the mic.
 *
 * It looks and sizes like the mic button in `dictation-control.tsx` (44 px square and icon-only in the
 * mobile action column, icon and the word "Live" in the desktop action row) and says whether Live is on
 * with `aria-pressed`, so the state is never only a colour. It holds no state: the composer decides what
 * a press does (start Live, or end it).
 */

import { AudioLines } from 'lucide-react';
import { cn } from '../lib/class-names.ts';
import { Button } from '../shell/primitives.tsx';

export interface LiveVoiceButtonProps {
  /** `compact` is the 44 px icon-only square; `full` adds the word. */
  readonly layout: 'compact' | 'full';
  /** Live is on. */
  readonly active: boolean;
  readonly disabled?: boolean;
  onPress(): void;
  /** The chord that toggles Live, as the person reads it ("⌥L"). Shown in the tooltip, never in the name. */
  readonly shortcutHint?: string;
}

export function LiveVoiceButton({ layout, active, disabled = false, onPress, shortcutHint }: LiveVoiceButtonProps) {
  const verb = active ? 'End Live voice' : 'Start Live voice';
  const title = shortcutHint === undefined ? verb : `${verb} (${shortcutHint})`;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cn('fy-live-button min-h-[44px] min-w-[44px] select-none px-2', active && 'text-accent')}
      disabled={disabled}
      aria-pressed={active}
      aria-label="Live voice"
      title={title}
      onClick={onPress}
    >
      <AudioLines size={15} aria-hidden="true" />
      {layout === 'full' ? <span className="ml-1 text-ui">Live</span> : null}
    </Button>
  );
}
