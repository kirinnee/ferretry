/**
 * The "Inserted · Undo" note shown when the device setting "Insert straight away" put a take into the
 * draft without a review. It is the cheap way back from a bad transcript: Undo restores the draft as it
 * was before the insertion, caret included.
 *
 * It lasts `INSERTED_TOAST_MS`, and it leaves on its own the moment the person edits the draft, because
 * restoring the old text over their typing would destroy it. The sentence sits in an always-mounted
 * polite live region, so a screen reader hears each insertion once.
 *
 * It is anchored exactly like the dictation panel (just above the composer), so the two never overlap:
 * the panel is closed by the time an automatic insertion lands.
 */

import { Undo2 } from 'lucide-react';
import { useEffect } from 'react';
import type { DictationAutoInsertion } from '../hooks/use-dictation.ts';
import { Button } from '../shell/primitives.tsx';

export const INSERTED_TOAST_MS = 8000;

/** Whether the draft is still the one the insertion produced — or the one it started from, mid-update. */
export const insertionStillUndoable = (insertion: DictationAutoInsertion, draft: string): boolean =>
  draft === insertion.after.text || draft === insertion.before.text;

export interface DictationInsertedToastProps {
  readonly insertion: DictationAutoInsertion | null;
  /** The composer's current draft. */
  readonly draft: string;
  onUndo(insertion: DictationAutoInsertion): void;
  onDismiss(): void;
  readonly durationMs?: number;
}

export function DictationInsertedToast({
  insertion,
  draft,
  onUndo,
  onDismiss,
  durationMs = INSERTED_TOAST_MS,
}: DictationInsertedToastProps) {
  const stale = insertion !== null && !insertionStillUndoable(insertion, draft);
  useEffect(() => {
    if (insertion === null) return;
    const timer = setTimeout(onDismiss, durationMs);
    return () => clearTimeout(timer);
  }, [durationMs, insertion, onDismiss]);
  useEffect(() => {
    if (stale) onDismiss();
  }, [onDismiss, stale]);

  const shown = insertion !== null && !stale;
  return (
    <div
      data-dictation-inserted={shown ? '' : undefined}
      className={
        shown
          ? 'absolute inset-x-0 bottom-[calc(100%+0.5rem)] z-50 flex min-h-[44px] items-center justify-between gap-2 rounded-panel border border-border bg-surface py-1 pl-3 pr-1 font-ui text-ui text-fg shadow-panel'
          : 'sr-only'
      }
    >
      <p role="status" className="m-0 min-w-0 truncate">
        {shown ? 'Inserted' : ''}
      </p>
      {shown ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="min-h-[44px] min-w-[44px] shrink-0 gap-1 font-semibold text-accent"
          aria-label="Undo the inserted dictation"
          onClick={() => onUndo(insertion)}
        >
          <Undo2 size={14} aria-hidden="true" />
          Undo
        </Button>
      ) : null}
    </div>
  );
}
