/**
 * The context rail, as a sheet. On a phone there is no room for a right rail, so
 * ◧ in the header opens the same body — Signals, MCP, Skills, Docs — in the
 * app's one shared bottom sheet. This file is only the frame: the body is the
 * caller's render prop, so the rail and the sheet can never drift apart.
 */

import { PanelRight } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { BottomSheet } from '../../../shell/bottom-sheet.tsx';

export interface ContextSheetProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Rendered only while the sheet is open, so a closed sheet costs nothing. */
  readonly renderBody: () => ReactNode;
  readonly title?: string;
}

export function ContextSheet({ open, onClose, renderBody, title = 'This folder' }: ContextSheetProps) {
  const headingId = useId();
  return (
    <BottomSheet
      id={`${headingId}-context-sheet`}
      open={open}
      onClose={onClose}
      labelledBy={headingId}
      closeLabel="Close context"
      // A fixed height: switching sub-tabs inside must not move the tab bar
      // under the reader's thumb.
      height="min(72dvh, calc(var(--app-h, 100dvh) - var(--gap-sm)))"
    >
      <h2 id={headingId} className="m-0 shrink-0 px-panel pb-xs text-ui font-semibold text-fg">
        {title}
      </h2>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-context-sheet-body="">
        {open ? renderBody() : null}
      </div>
    </BottomSheet>
  );
}

/** ◧ — the header button that opens the sheet. */
export function ContextSheetButton({ open, onOpen }: { readonly open: boolean; readonly onOpen: () => void }) {
  return (
    <button
      type="button"
      aria-label="Open context"
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={onOpen}
      className="flex min-h-control min-w-[var(--control-h)] shrink-0 items-center justify-center rounded-control text-muted hover:bg-surface-2 hover:text-fg"
    >
      <PanelRight size={16} aria-hidden="true" />
    </button>
  );
}
