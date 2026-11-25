/**
 * The runtime picker the composer shows (`composer.tools` › `runtime-picker`): the model, the thinking level and the speed of
 * the ferret the panel is shown for. The ferret is the panel's `subject`.
 *
 * THREE QUIET READOUTS ON THE COMPOSER'S STATUS LINE, ONE POPOVER BEHIND THEM (v4's bar: the values are ON the bar, and a
 * tap on one changes it). The bar reads `<model> · <thinking> · <Normal|Fast>`; each is a real button that opens the same
 * popover on its own list (Model, Reasoning, Speed), reusing this plugin's model and effort controls and adding only the
 * speed list beside them. A value the ferret has not reported reads as the plain word `Default` (it runs on the harness's own choice; the tooltip names the field), never a guess.
 * The composer draws this panel on its status line, under the row (Conversation's `STATUS_PANELS`), because anything it
 * drew in the row would take the text box's room. The popover is a portal with fixed placement, so nothing it holds can
 * make the composer taller, and it asks for the model catalog only once opened. On a phone the same lists open in the app's
 * bottom sheet instead (v4's shape): a floating popover over a phone's keyboard-sized composer has no room to be read or tapped.
 */

import { BottomSheet, useLayoutMode } from '@ferretry/app/ui';
import { FerretsChanged } from '@ferretry/core-ferrets/contract';
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
import { isSupportedHarnessKey } from '../../contract/harness-words.ts';
import { modelDisplayName } from '../../contract/index.ts';
import { readAccountPickerCatalog } from '../lib/account-picker-catalog.ts';
import type { LiveRuntimesClient } from '../lib/client.ts';
import { DaemonRuntimeModelCatalogStore, type RuntimeModelCatalog } from '../lib/runtime-models.ts';
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

export const createRuntimePicker = (client: LiveRuntimesClient): AppComponent<PanelProps> => {
  const api = runtimeControlApi(client);
  const store = new DaemonRuntimeModelCatalogStore();
  const catalogs = { load: (sessionId: string) => store.load(client, sessionId) };
  return function RuntimePicker({ subject }: PanelProps): ReactNode {
    const [view, setView] = useState<RuntimeSessionView | null>(null);
    const [failure, setFailure] = useState<string | null>(null);
    // The words for the runtime this ferret runs on ("Claude · your terminal sign-in"); absent until the roster is read, and never guessed.
    const [runsOn, setRunsOn] = useState<string | null>(null);
    // The catalog's labels, read quietly once the ferret is: they name the model on the chip. A catalog that cannot be read
    // is not an error here (the popover says so when it is opened): the chip then draws the id.
    const [labels, setLabels] = useState<RuntimeModelCatalog | null>(null);
    const [section, setSection] = useState<Section | null>(null);
    const [sent, setSent] = useState<Sent>({});
    const [placement, setPlacement] = useState<Placement | null>(null);
    const chip = useRef<HTMLButtonElement | null>(null);
    const panel = useRef<HTMLDivElement | null>(null);
    const refreshNow = useRef<() => void>(() => undefined);
    const lists = {
      model: useRef<HTMLDivElement | null>(null),
      effort: useRef<HTMLDivElement | null>(null),
      speed: useRef<HTMLDivElement | null>(null),
    };
    const phone = useLayoutMode() === 'drawer';
    const open = section !== null;
    useEffect(() => {
      if (subject === undefined) return;
      let live = true;
      setView(null);
      setFailure(null);
      setRunsOn(null);
      setLabels(null);
      setSection(null);
      setSent({});
      readRuntimeSessionView(client, subject).then(
        read => {
          if (!live) return;
          setView(read);
          // A harness this build has no behaviour for has no model list to ask for.
          if (isSupportedHarnessKey(read.config.harness))
            catalogs.load(subject).then(
              catalog => {
                if (live) setLabels(catalog);
              },
              () => undefined,
            );
          const wrapper = read.config.runtime;
          if (wrapper === undefined) return;
          readAccountPickerCatalog(client).then(
            roster => {
              if (live) setRunsOn(roster.accounts.find(account => account.wrapper === wrapper)?.displayName ?? null);
            },
            () => undefined,
          );
        },
        cause => {
          if (live) setFailure(cause instanceof Error ? cause.message : String(cause));
        },
      );
      return () => {
        live = false;
      };
    }, [subject]);

    // Every list reads the ferret's CURRENT state, not the one read when the page opened: it is read again after each
    // change this picker sends, when the popover opens, and when the daemon says the ferret changed state (a ferret that
    // was working when the page opened and has gone idle since must not leave the controls disabled). A read that fails
    // keeps the last state read: the lists never go blank over a refresh.
    useEffect(() => {
      if (subject === undefined) return;
      let live = true;
      const refresh = (): void => {
        readRuntimeSessionView(client, subject).then(
          read => {
            if (live) setView(read);
          },
          () => undefined,
        );
      };
      refreshNow.current = refresh;
      const stop = client.subscribe?.(FerretsChanged, changed => {
        if (changed.ferret === subject) refresh();
      });
      return () => {
        live = false;
        refreshNow.current = () => undefined;
        stop?.();
      };
    }, [subject]);
    useEffect(() => {
      if (open) refreshNow.current();
    }, [open]);

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
      // A list with nothing to choose (an unsupported speed, a busy ferret) gives focus to the popover itself, so the
      // keyboard is never left on a page behind it.
      const target = list?.querySelector<HTMLElement>('[tabindex="0"]:not(:disabled)') ?? panel.current;
      target?.focus({ preventScroll: true });
      list?.scrollIntoView?.({ block: 'nearest' });
      // A list changes under a focused choice (the model catalog arrives and Fast turns out to be unsupported, so the
      // choices become a sentence): the browser would drop focus to the page behind, so the popover takes it instead.
      const popover = panel.current;
      if (popover === null) return;
      const watch = new MutationObserver(() => {
        if (document.activeElement === null || document.activeElement === document.body)
          popover.focus({ preventScroll: true });
      });
      watch.observe(popover, { childList: true, subtree: true });
      return () => watch.disconnect();
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

    // A choice that was sent leaves focus on the chip that opened the list, never on the control it disabled.
    const common = useMemo(
      () => ({
        api,
        catalogs,
        canControl: true,
        onClose: () => close(true),
        onModelSent: (model: string, effort?: string) => {
          setSent(current => ({ ...current, model, ...(effort === undefined ? {} : { effort }) }));
          refreshNow.current();
          chip.current?.focus({ preventScroll: true });
        },
        onClaudeEffortSent: (effort: string) => {
          setSent(current => ({ ...current, effort }));
          refreshNow.current();
          chip.current?.focus({ preventScroll: true });
        },
      }),
      [close],
    );
    if (subject === undefined) return null;
    if (failure !== null) return <p role="alert">{failure}</p>;
    if (view === null) return null;
    const parts: RuntimeParts = { ...runtimeParts(view), ...sent };
    // The ferret as it stands now: what was read, with what this browser has sent since laid over it.
    const current: RuntimeSessionView = {
      ...view,
      state: {
        ...view.state,
        ...(parts.model === undefined ? {} : { observedModel: parts.model }),
        ...(parts.effort === undefined ? {} : { observedReasoningEffort: parts.effort }),
        ...(parts.fast === undefined ? {} : { observedFast: parts.fast }),
      },
    };
    const modelName = (id: string): string =>
      modelDisplayName(
        id,
        (labels?.choices ?? []).map(choice => ({ id: choice.value, label: choice.label })),
      );
    const label = runtimeReadout(current, modelName);
    const fast = parts.fast === true;
    const chips: readonly {
      readonly key: Section;
      readonly text: string;
      readonly title: string;
      /** The raw value, on demand: the tooltip, never drawn. */
      readonly detail?: string;
      readonly icon?: ReactNode;
    }[] = [
      {
        key: 'model',
        text: parts.model === undefined ? 'Default' : modelName(parts.model),
        title: 'Change the model',
        ...(parts.model === undefined || modelName(parts.model) === parts.model ? {} : { detail: parts.model }),
      },
      {
        key: 'effort',
        text: parts.effort ?? 'Default',
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
    // The same three lists in both shells: the popover above the composer, or on a phone the app's bottom sheet.
    const choices = (
      <>
        {runsOn === null ? null : (
          <p className="m-0 px-cell-x pb-2 text-meta leading-base text-muted" data-runtime-runs-on="">
            Runs on <span className="font-semibold text-fg">{runsOn}</span>
          </p>
        )}
        <div data-runtime-list="model" ref={lists.model}>
          <div className="kt-label px-cell-x pb-0.5">Model</div>
          <RuntimeMenuFocusContext.Provider value={focusFor('model')}>
            <RuntimeModelControls {...common} open presentation="popover" view={current} />
          </RuntimeMenuFocusContext.Provider>
        </div>
        <div data-runtime-list="effort" ref={lists.effort}>
          <div className="kt-label mt-2 px-cell-x pb-0.5">Thinking</div>
          <RuntimeMenuFocusContext.Provider value={focusFor('effort')}>
            <RuntimeEffortControls {...common} {...effortProps} presentation="popover" view={current} />
          </RuntimeMenuFocusContext.Provider>
        </div>
        <div data-runtime-list="speed" ref={lists.speed}>
          <div className="kt-label mt-2 px-cell-x pb-0.5">Speed</div>
          <RuntimeMenuFocusContext.Provider value={focusFor('speed')}>
            <RuntimeSpeedControls
              {...common}
              fast={fast}
              onFastSent={next => {
                setSent(was => ({ ...was, fast: next }));
                refreshNow.current();
              }}
              presentation="popover"
              view={current}
            />
          </RuntimeMenuFocusContext.Provider>
        </div>
      </>
    );
    const popover = (
      <div
        aria-label="Model, thinking and speed"
        className="kt-popover fixed z-50 overflow-y-auto p-2"
        data-runtime-popover=""
        ref={panel}
        role="dialog"
        tabIndex={-1}
        style={
          placement === null
            ? undefined
            : {
                bottom: placement.bottom,
                left: placement.left,
                maxHeight: placement.maxHeight,
                width: placement.width,
              }
        }
      >
        {choices}
      </div>
    );
    const sheet = (
      <BottomSheet
        ariaLabel="Model, thinking and speed"
        closeLabel="Close"
        id="runtime-picker-sheet"
        maxHeight="min(90dvh, calc(var(--app-h, 100dvh) - var(--gap-sm)))"
        onClose={() => close(true)}
        open
        panelClassName="mx-auto max-w-[720px]"
      >
        <div
          className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto p-panel"
          data-runtime-popover=""
          data-runtime-sheet=""
          ref={panel}
          tabIndex={-1}
        >
          {choices}
        </div>
      </BottomSheet>
    );
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
            title={`${entry.title} — ${label}${entry.detail === undefined ? '' : ` (${entry.detail})`}`}
            type="button"
          >
            {entry.icon}
            <span>{entry.text}</span>
          </button>
        ))}
        {open && placement !== null ? createPortal(phone ? sheet : popover, document.body) : null}
      </div>
    );
  };
};
