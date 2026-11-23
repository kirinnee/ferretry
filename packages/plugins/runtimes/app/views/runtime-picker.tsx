/**
 * The runtime picker the composer shows (`composer.tools` › `runtime-picker`): the model, the thinking level and the speed of
 * the ferret the panel is shown for. The ferret is the panel's `subject`.
 *
 * THREE QUIET READOUTS ON THE COMPOSER'S STATUS LINE, ONE POPOVER BEHIND THEM (v4's bar: the values are ON the bar, and a
 * tap on one changes it). The bar reads `<model> · <thinking> · <Normal|Fast>`; each is a real button that opens the same
 * popover on its own list (Model, Reasoning, Speed), reusing this plugin's model and effort controls and adding only the
 * speed list beside them. A value the ferret has not reported reads as a plain word (`Model`, `Thinking`), never a guess.
 * The composer draws this panel on its status line, under the row (Conversation's `STATUS_PANELS`), because anything it
 * drew in the row would take the text box's room. The popover is a portal with fixed placement, so nothing it holds can
 * make the composer taller, and it asks for the model catalog only once opened.
 */

import type { AppComponent, PanelProps } from '@ferretry/kernel/manifest';
import { Brain, Zap } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  RuntimeEffortControls,
  RuntimeMenuFocusContext,
  RuntimeModelControls,
  RuntimeSpeedControls,
} from '../components/runtime-controls.tsx';
import type { RuntimesClient } from '../lib/client.ts';
import { DaemonRuntimeModelCatalogStore } from '../lib/runtime-models.ts';
import { readRuntimeSessionView, runtimeControlApi } from '../lib/runtime-switch.ts';
import { type RuntimeParts, type RuntimeSessionView, runtimeParts, runtimeReadout } from '../lib/session-view.ts';

type Section = 'model' | 'effort' | 'speed';

/** What this browser has SENT since the view was read: shown on the bar as sent, never as an observation. */
type Sent = Pick<RuntimeParts, 'model' | 'effort' | 'fast'>;

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

export const createRuntimePicker = (client: RuntimesClient): AppComponent<PanelProps> => {
  const api = runtimeControlApi(client);
  const store = new DaemonRuntimeModelCatalogStore();
  const catalogs = { load: (sessionId: string) => store.load(client, sessionId) };
  return function RuntimePicker({ subject }: PanelProps): ReactNode {
    const [view, setView] = useState<RuntimeSessionView | null>(null);
    const [failure, setFailure] = useState<string | null>(null);
    const [section, setSection] = useState<Section | null>(null);
    const [sent, setSent] = useState<Sent>({});
    const [placement, setPlacement] = useState<Placement | null>(null);
    const chip = useRef<HTMLButtonElement | null>(null);
    const panel = useRef<HTMLDivElement | null>(null);
    const lists = {
      model: useRef<HTMLDivElement | null>(null),
      effort: useRef<HTMLDivElement | null>(null),
      speed: useRef<HTMLDivElement | null>(null),
    };
    const open = section !== null;
    useEffect(() => {
      if (subject === undefined) return;
      let live = true;
      setView(null);
      setFailure(null);
      setSection(null);
      setSent({});
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
      setSection(null);
      if (returnFocus) chip.current?.focus({ preventScroll: true });
    }, []);

    const place = useCallback((): void => {
      const anchor = chip.current?.getBoundingClientRect();
      if (anchor === undefined) return;
      // Above the whole composer, left edges with it: the popover never covers the text box being written in, and it sits
      // in the same place whichever readout opened it. With no composer around (a bare panel) it sits above the chip.
      const composer = chip.current?.closest('form')?.getBoundingClientRect();
      setPlacement(popoverPlacement(composer ?? anchor, { width: window.innerWidth, height: window.innerHeight }));
    }, []);

    // Placed before the first paint, and kept placed through the resizes a keyboard or a tray causes.
    useLayoutEffect(() => {
      if (!open) return;
      place();
      window.addEventListener('resize', place);
      return () => window.removeEventListener('resize', place);
    }, [open, place]);

    // The list the reader asked for is the one that holds focus and is in view, also when another chip moves the popover.
    // biome-ignore lint/correctness/useExhaustiveDependencies: the three list refs are stable
    useEffect(() => {
      if (section === null || placement === null) return;
      const list = lists[section].current;
      list?.querySelector<HTMLElement>('[tabindex="0"]')?.focus({ preventScroll: true });
      list?.scrollIntoView?.({ block: 'nearest' });
    }, [section, placement !== null]);

    useEffect(() => {
      if (!open) return;
      const onKey = (event: KeyboardEvent): void => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        close(true);
      };
      const onOutside = (event: Event): void => {
        const target = event.target as Node | null;
        if (
          target === null ||
          chip.current?.contains(target) ||
          panel.current?.contains(target) ||
          // Another chip of this bar moves the popover to its list itself (its own click).
          (target instanceof Element && target.closest('[data-runtime-chip]') !== null)
        )
          return;
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

    const common = useMemo(
      () => ({
        api,
        catalogs,
        canControl: true,
        onClose: () => setSection(null),
        onModelSent: (model: string, effort?: string) =>
          setSent(current => ({ ...current, model, ...(effort === undefined ? {} : { effort }) })),
        onClaudeEffortSent: (effort: string) => setSent(current => ({ ...current, effort })),
      }),
      [],
    );
    if (subject === undefined) return null;
    if (failure !== null) return <p role="alert">{failure}</p>;
    if (view === null) return null;
    const parts: RuntimeParts = { ...runtimeParts(view), ...sent };
    const label = runtimeReadout({
      ...view,
      state: {
        ...view.state,
        ...(parts.model === undefined ? {} : { observedModel: parts.model }),
        ...(parts.effort === undefined ? {} : { observedReasoningEffort: parts.effort }),
        ...(parts.fast === undefined ? {} : { observedFast: parts.fast }),
      },
    });
    const fast = parts.fast === true;
    const chips: readonly {
      readonly key: Section;
      readonly text: string;
      readonly title: string;
      readonly icon?: ReactNode;
    }[] = [
      { key: 'model', text: parts.model ?? 'Model', title: 'Change the model' },
      {
        key: 'effort',
        text: parts.effort ?? 'Thinking',
        title: 'Change the thinking level',
        icon: <Brain aria-hidden="true" className="shrink-0" size={12} />,
      },
      {
        key: 'speed',
        text: fast ? 'Fast' : 'Normal',
        title: 'Change the speed',
        icon: <Zap aria-hidden="true" className="shrink-0" size={12} />,
      },
    ];
    const focusFor = (key: Section) => section === key;
    // The thinking level the effort list checks is the one the bar names, so the two always agree.
    const effortProps = parts.effort === undefined ? {} : { claudeEffort: parts.effort };
    return (
      <div className="fy-runtime-picker shrink-0" data-runtime-picker={subject}>
        {chips.map(entry => (
          <button
            aria-expanded={section === entry.key}
            aria-haspopup="dialog"
            aria-label={`${entry.title} — ${label}`}
            className="kt-btn fy-runtime-chip !w-auto inline-flex min-w-0 items-center justify-center gap-1 px-1 py-1 text-meta"
            data-runtime-chip={entry.key}
            key={entry.key}
            onClick={event => {
              chip.current = event.currentTarget;
              setSection(current => (current === entry.key ? null : entry.key));
              place();
            }}
            title={`${entry.title} — ${label}`}
            type="button"
          >
            {entry.icon}
            <span>{entry.text}</span>
          </button>
        ))}
        {open && placement !== null
          ? createPortal(
              <div
                aria-label="Model, thinking and speed"
                className="kt-popover fixed z-50 overflow-y-auto p-2"
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
                <div data-runtime-list="model" ref={lists.model}>
                  <div className="kt-label px-cell-x pb-0.5">Model</div>
                  <RuntimeMenuFocusContext.Provider value={focusFor('model')}>
                    <RuntimeModelControls {...common} open presentation="popover" view={view} />
                  </RuntimeMenuFocusContext.Provider>
                </div>
                <div data-runtime-list="effort" ref={lists.effort}>
                  <div className="kt-label mt-2 px-cell-x pb-0.5">Thinking</div>
                  <RuntimeMenuFocusContext.Provider value={focusFor('effort')}>
                    <RuntimeEffortControls {...common} {...effortProps} presentation="popover" view={view} />
                  </RuntimeMenuFocusContext.Provider>
                </div>
                <div data-runtime-list="speed" ref={lists.speed}>
                  <div className="kt-label mt-2 px-cell-x pb-0.5">Speed</div>
                  <RuntimeMenuFocusContext.Provider value={focusFor('speed')}>
                    <RuntimeSpeedControls
                      {...common}
                      fast={fast}
                      onFastSent={next => setSent(current => ({ ...current, fast: next }))}
                      presentation="popover"
                      view={view}
                    />
                  </RuntimeMenuFocusContext.Provider>
                </div>
              </div>,
              document.body,
            )
          : null}
      </div>
    );
  };
};
