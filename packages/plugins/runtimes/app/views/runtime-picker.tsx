/**
 * The runtime picker the composer shows (`composer.tools` › `runtime-picker`): the model and the reasoning-level
 * switches of the ferret the panel is shown for. The ferret is the panel's `subject`.
 *
 * ONE SMALL CHIP IN THE COMPOSER'S ROW, THE LISTS IN A POPOVER (v4's composer-runtime: a chip on the bar that opens a
 * picker). The panel sits in the row beside the text box, so anything it draws in flow takes the box's room: it used to
 * draw both lists open, a four-row column that squeezed the text to one word and pushed Send below the window. The
 * popover is a portal with fixed placement, so nothing it holds can make the composer taller, and it asks for the model
 * catalog only once opened — a daemon without runtime discovery says so inside the popover, not on every page.
 */

import type { AppComponent, PanelProps } from '@ferretry/kernel/manifest';
import { SlidersHorizontal } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { RuntimeEffortControls, RuntimeModelControls } from '../components/runtime-controls.tsx';
import type { RuntimesClient } from '../lib/client.ts';
import { DaemonRuntimeModelCatalogStore } from '../lib/runtime-models.ts';
import { readRuntimeSessionView, runtimeControlApi } from '../lib/runtime-switch.ts';
import { launchedModel, type RuntimeSessionView } from '../lib/session-view.ts';

const MARGIN = 8;
const WIDTH = 352;

interface Placement {
  readonly left: number;
  readonly bottom: number;
  readonly width: number;
  readonly maxHeight: number;
}

/** Above the chip, left edges aligned, inside the window on every side. Pure: a function of two rectangles. */
const popoverPlacement = (
  anchor: { readonly left: number; readonly top: number },
  viewport: { readonly width: number; readonly height: number },
): Placement => {
  const width = Math.min(WIDTH, viewport.width - 2 * MARGIN);
  return {
    left: Math.max(MARGIN, Math.min(anchor.left, viewport.width - width - MARGIN)),
    bottom: Math.max(MARGIN, viewport.height - anchor.top + MARGIN),
    width,
    maxHeight: Math.max(160, anchor.top - 2 * MARGIN),
  };
};

/** What the chip says: the model in force, else the one the session was launched on, else a plain word. */
const chipLabel = (view: RuntimeSessionView): string =>
  view.state.observedModel?.trim() || launchedModel(view.config) || 'Model';

export const createRuntimePicker = (client: RuntimesClient): AppComponent<PanelProps> => {
  const api = runtimeControlApi(client);
  const store = new DaemonRuntimeModelCatalogStore();
  const catalogs = { load: (sessionId: string) => store.load(client, sessionId) };
  return function RuntimePicker({ subject }: PanelProps): ReactNode {
    const [view, setView] = useState<RuntimeSessionView | null>(null);
    const [failure, setFailure] = useState<string | null>(null);
    const [open, setOpen] = useState(false);
    const [placement, setPlacement] = useState<Placement | null>(null);
    const chip = useRef<HTMLButtonElement | null>(null);
    const panel = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
      if (subject === undefined) return;
      let live = true;
      setView(null);
      setFailure(null);
      setOpen(false);
      readRuntimeSessionView(client, subject).then(
        read => {
          if (live) setView(read);
        },
        cause => {
          if (live) setFailure(cause instanceof Error ? cause.message : String(cause));
        },
      );
      return () => {
        live = false;
      };
    }, [subject]);

    const close = useCallback((returnFocus: boolean): void => {
      setOpen(false);
      if (returnFocus) chip.current?.focus({ preventScroll: true });
    }, []);

    const place = useCallback((): void => {
      const anchor = chip.current?.getBoundingClientRect();
      if (anchor === undefined) return;
      setPlacement(popoverPlacement(anchor, { width: window.innerWidth, height: window.innerHeight }));
    }, []);

    // Placed before the first paint, and kept placed through the resizes a keyboard or a tray causes.
    useLayoutEffect(() => {
      if (!open) return;
      place();
      window.addEventListener('resize', place);
      return () => window.removeEventListener('resize', place);
    }, [open, place]);

    useEffect(() => {
      if (!open) return;
      const onKey = (event: KeyboardEvent): void => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        close(true);
      };
      const onOutside = (event: Event): void => {
        const target = event.target as Node | null;
        if (target === null || chip.current?.contains(target) || panel.current?.contains(target)) return;
        close(false);
      };
      document.addEventListener('keydown', onKey, true);
      document.addEventListener('pointerdown', onOutside, true);
      document.addEventListener('mousedown', onOutside, true);
      return () => {
        document.removeEventListener('keydown', onKey, true);
        document.removeEventListener('pointerdown', onOutside, true);
        document.removeEventListener('mousedown', onOutside, true);
      };
    }, [open, close]);

    const common = useMemo(() => ({ api, catalogs, canControl: true, onClose: () => setOpen(false) }), []);
    if (subject === undefined) return null;
    if (failure !== null) return <p role="alert">{failure}</p>;
    if (view === null) return null;
    const label = chipLabel(view);
    return (
      <div className="fy-runtime-picker shrink-0" data-runtime-picker={subject}>
        <button
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={`Change model and reasoning — ${label}`}
          className="kt-btn fy-runtime-chip !w-auto inline-flex max-w-[9rem] min-w-0 items-center justify-center gap-1 px-2 py-1 text-meta"
          data-runtime-chip=""
          onClick={() => setOpen(current => !current)}
          ref={chip}
          title={`Model and reasoning level — ${label}`}
          type="button"
        >
          <SlidersHorizontal aria-hidden="true" className="shrink-0" size={14} />
          {/* A phone's row has no room for a name: the icon alone is the chip (the name is on its label and in the popover). */}
          <span className="hidden min-w-0 truncate sm:inline">{label}</span>
        </button>
        {open && placement !== null
          ? createPortal(
              <div
                aria-label="Model and reasoning"
                className="fixed z-50 overflow-y-auto rounded-control border border-border-strong bg-surface p-2 shadow-lg"
                data-runtime-popover=""
                ref={panel}
                role="dialog"
                style={{
                  bottom: placement.bottom,
                  left: placement.left,
                  maxHeight: placement.maxHeight,
                  width: placement.width,
                }}
              >
                <div className="kt-label px-cell-x pb-0.5">Model</div>
                <RuntimeModelControls {...common} open presentation="popover" view={view} />
                <div className="kt-label mt-2 px-cell-x pb-0.5">Reasoning</div>
                <RuntimeEffortControls {...common} presentation="popover" view={view} />
              </div>,
              document.body,
            )
          : null}
      </div>
    );
  };
};
