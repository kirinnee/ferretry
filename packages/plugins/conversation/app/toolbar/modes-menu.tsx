/**
 * THE FERRET'S ONE MENU: a single "Modes" button at the end of the header's main line (the name and the status), and
 * everything else one click behind it — what a person can do to or learn about this ferret (Ferrets' Actions rows and
 * Info, mounted from {@link FERRET_MENU_SLOT}) and what changes what it is told or may do (Agenda mode, Hypermedia,
 * Passive lessons, Compact memory at, the lessons scan: {@link CONVERSATION_MODES_SLOT}).
 *
 * Each row is a panel another plugin (or Conversation) contributes; this menu only mounts the two slots. It is a popover
 * under the button on a desktop and the app's bottom sheet on a phone, and drawn only where some usable panel is
 * contributed — a daemon with nothing to offer shows no button at all.
 *
 * A closed menu reads nothing: the panels are mounted on its FIRST opening. After that they stay mounted (shut, not
 * gone) in one element this menu owns and moves between the popover and the phone sheet (a bottom sheet draws nothing
 * once shut, so mounting the panels in it would drop them), so a save that is refused, a passkey that is dismissed or a "takes effect at the next launch" that arrives after
 * the person clicked away is still said, and a dialog a panel opened (Info, a form, the lessons scan) is not closed under
 * them. What a panel must show outside the menu it draws through `Floating`, which this menu points at the page's
 * body: a dialog inside the phone sheet would otherwise be boxed in by its transform, and one inside the shut menu hidden.
 */

import { PanelSlot, useSlotHasUsablePanels } from '@ferretry/app';
import { BottomSheet, FloatingHost, useDialogFocus, useLayoutMode, useScrimDismiss } from '@ferretry/app/ui';
import { FERRET_MENU_SLOT } from '@ferretry/core-ferrets/contract';
import { ChevronDown, SlidersHorizontal } from 'lucide-react';
import { type ReactNode, useCallback, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
  const hasFerretRows = useSlotHasUsablePanels(daemon, FERRET_MENU_SLOT);
  const hasModes = useSlotHasUsablePanels(daemon, CONVERSATION_MODES_SLOT);
  const offered = hasFerretRows || hasModes;
  const [open, setOpen] = useState(false);
  // Mounted on the first opening and kept (see the file's note).
  const [opened, setOpened] = useState(false);
  // The element the panels are mounted in; the popover or the open sheet adopts it, a shut sheet lets it go (unattached,
  // but still mounted: a portal into it keeps every panel's state and its pending saves).
  const [holder] = useState<HTMLElement | null>(() =>
    typeof document === 'undefined' ? null : document.createElement('div'),
  );
  const adopt = (node: HTMLElement | null): void => {
    if (node !== null && holder !== null && holder.parentNode !== node) node.appendChild(holder);
  };
  const [place, setPlace] = useState<{ readonly top: number; readonly right: number }>({ top: 0, right: 8 });
  const button = useRef<HTMLButtonElement | null>(null);
  const popover = useRef<HTMLDivElement | null>(null);
  const close = useCallback((): void => setOpen(false), []);
  const { onKeyDown } = useDialogFocus(open && !phone, popover, close);
  const scrim = useScrimDismiss(close);
  if (!offered) return null;

  const floating = typeof document === 'undefined' ? null : document.body;
  const body = opened ? (
    <FloatingHost dismiss={close} element={floating} open={open}>
      {hasFerretRows ? (
        <section aria-label="This ferret" className="fy-modes__section" data-modes-section="ferret">
          <PanelSlot daemon={daemon} slot={FERRET_MENU_SLOT} subject={ferret} />
        </section>
      ) : null}
      {hasModes ? (
        <section aria-label="Modes" className="fy-modes__section" data-modes-section="modes">
          <p className="fy-modes__hint">Switches that change what this ferret is told or may do.</p>
          <PanelSlot daemon={daemon} slot={CONVERSATION_MODES_SLOT} subject={ferret} />
        </section>
      ) : null}
    </FloatingHost>
  ) : null;
  const mounted: ReactNode = holder === null || body === null ? null : createPortal(body, holder);
  return (
    <div className="fy-modes" data-modes-menu="">
      {mounted}
      <button
        aria-controls={open ? id : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={phone ? 'Modes' : undefined}
        className="kt-btn kt-btn--sm"
        data-modes-trigger=""
        onClick={() => {
          setPlace(placementUnder(button.current));
          setOpened(true);
          setOpen(current => !current);
        }}
        ref={button}
        type="button"
      >
        <SlidersHorizontal aria-hidden="true" size={14} />
        {phone ? null : <span>Modes</span>}
        <ChevronDown aria-hidden="true" size={14} />
      </button>
      {open && !phone ? <div aria-hidden="true" className="fy-modes__scrim" {...scrim} /> : null}
      {opened && !phone ? (
        <div
          aria-label="Modes"
          aria-modal="false"
          className="fy-modes__popover kt-panel"
          data-modes-body=""
          hidden={!open}
          id={id}
          onKeyDown={onKeyDown}
          ref={popover}
          role="dialog"
          style={place}
          tabIndex={-1}
        >
          <div ref={adopt} />
        </div>
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
            <div ref={adopt} />
          </div>
        </BottomSheet>
      ) : null}
    </div>
  );
}
