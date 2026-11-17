/**
 * THE FERRET'S MODES MENU: one "Modes" button on the header's main line, and everything that changes what a ferret is
 * told or may do (Agenda mode, Hypermedia, Passive lessons, Compact memory at, the lessons scan) one click behind it.
 *
 * The header stays the name and the status; each mode is a panel another plugin (or Conversation) contributes to
 * {@link CONVERSATION_MODES_SLOT}, and this menu only mounts that slot. It is a popover under the button on a desktop
 * and the app's bottom sheet on a phone, mounted only while open (a closed menu reads nothing), and drawn only where
 * some usable panel is contributed — a daemon with no mode to offer shows no button at all.
 */

import { PanelSlot, useSlotHasUsablePanels } from '@ferretry/app';
import { BottomSheet, useDialogFocus, useLayoutMode, useScrimDismiss } from '@ferretry/app/ui';
import { ChevronDown, SlidersHorizontal } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { CONVERSATION_MODES_SLOT } from '../../contract/index.ts';
import './modes-menu.css';

/** Where the popover hangs: under the button, right edges aligned, never off screen. */
const placementUnder = (button: HTMLElement | null): { readonly top: number; readonly right: number } => {
  const rect = button?.getBoundingClientRect();
  const width = typeof window === 'undefined' ? 0 : window.innerWidth;
  return { top: Math.round((rect?.bottom ?? 0) + 6), right: Math.max(8, Math.round(width - (rect?.right ?? width))) };
};

export function ModesMenu({ daemon, ferret }: { readonly daemon: string; readonly ferret: string }) {
  const id = useId();
  const phone = useLayoutMode() === 'drawer';
  const offered = useSlotHasUsablePanels(daemon, CONVERSATION_MODES_SLOT);
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<{ readonly top: number; readonly right: number }>({ top: 0, right: 8 });
  const button = useRef<HTMLButtonElement | null>(null);
  const popover = useRef<HTMLDivElement | null>(null);
  const close = (): void => setOpen(false);
  const { onKeyDown } = useDialogFocus(open && !phone, popover, close);
  const scrim = useScrimDismiss(close);
  if (!offered) return null;

  const body = <PanelSlot daemon={daemon} slot={CONVERSATION_MODES_SLOT} subject={ferret} />;
  return (
    <div className="fy-modes" data-modes-menu="">
      <button
        aria-controls={open ? id : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="kt-btn kt-btn--sm"
        data-modes-trigger=""
        onClick={() => {
          setPlace(placementUnder(button.current));
          setOpen(current => !current);
        }}
        ref={button}
        type="button"
      >
        <SlidersHorizontal aria-hidden="true" size={14} />
        <span>Modes</span>
        <ChevronDown aria-hidden="true" size={14} />
      </button>
      {open && !phone ? (
        <>
          <div aria-hidden="true" className="fy-modes__scrim" {...scrim} />
          <div
            aria-label="Modes"
            aria-modal="false"
            className="fy-modes__popover kt-panel"
            data-modes-body=""
            id={id}
            onKeyDown={onKeyDown}
            ref={popover}
            role="dialog"
            style={place}
            tabIndex={-1}
          >
            <p className="fy-modes__hint">Switches that change what this ferret is told or may do.</p>
            {body}
          </div>
        </>
      ) : null}
      {phone ? (
        <BottomSheet
          closeLabel="Close Modes"
          id={id}
          onClose={close}
          open={open}
          ariaLabel="Modes"
          panelClassName="bg-surface"
        >
          <div className="fy-modes__sheet min-h-0 flex-1 overflow-y-auto" data-modes-body="">
            <p className="fy-modes__hint">Switches that change what this ferret is told or may do.</p>
            {open ? body : null}
          </div>
        </BottomSheet>
      ) : null}
    </div>
  );
}
