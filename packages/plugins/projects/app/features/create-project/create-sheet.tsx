/**
 * THE CREATE STEPPER'S SHELL: a centred sheet over the page on a desktop, the whole screen on a phone.
 *
 * It only holds the dialog contract (Escape, focus in and back, Tab trap, a click on the scrim closes) and a Close button
 * above the stepper; the steps draw themselves in `StepPageFrame`.
 *
 * ONE SCROLL BOX. The sheet is as tall as its step needs, up to 94 dvh; the Close row stays put and the step body below
 * it is the only thing that scrolls, and only when it is longer than the room. Nothing inside it scrolls on its own
 * (the folder list is plain flow), and the frame's `min-height: 100%` is lifted so a short step does not stretch.
 */
import { useDialogFocus, useLayoutMode, useScrimDismiss } from '@ferretry/app/ui';
import { X } from 'lucide-react';
import { type ReactNode, useRef } from 'react';

export interface CreateSheetProps {
  readonly onClose: () => void;
  readonly children: ReactNode;
}

export function CreateSheet({ onClose, children }: CreateSheetProps) {
  const phone = useLayoutMode() === 'drawer';
  const panel = useRef<HTMLDivElement>(null);
  const { onKeyDown } = useDialogFocus(true, panel, onClose);
  const scrim = useScrimDismiss(onClose);
  return (
    <div
      className={`fixed inset-0 z-40 flex ${phone ? '' : 'items-center justify-center p-md'}`}
      data-create-sheet={phone ? 'page' : 'sheet'}
    >
      {!phone && (
        <button
          type="button"
          aria-label="Close the create-project steps"
          {...scrim}
          className="absolute inset-0 cursor-default bg-scrim"
        />
      )}
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Create a project"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={
          phone
            ? 'relative z-10 flex h-dvh min-h-0 w-full flex-col overflow-hidden bg-bg outline-none focus:outline-none focus-visible:outline-none'
            : 'kt-panel relative z-10 flex max-h-[94dvh] min-h-0 w-full max-w-[920px] flex-col overflow-hidden outline-none focus:outline-none focus-visible:outline-none'
        }
      >
        <div className="flex shrink-0 justify-end px-2 pt-2">
          <button type="button" className="kt-btn min-h-control" onClick={onClose} data-create-close="">
            <X size={14} aria-hidden="true" />
            Close
          </button>
        </div>
        <div
          className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden [&_.fy-spf]:min-h-0"
          data-create-body=""
        >
          {children}
        </div>
      </div>
    </div>
  );
}
