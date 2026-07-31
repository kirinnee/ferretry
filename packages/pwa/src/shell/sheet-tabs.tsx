/**
 * The details sheet's tab strip — real WAI-ARIA tabs. Ported from kteam
 * `ui/src/components/SheetTabs.tsx`.
 *
 * This IS a tab pattern (unlike `ViewTabs`, which is an honest toggle group):
 * each button owns `role="tab"` + `aria-controls` pointing at a
 * `role="tabpanel"`, there is a roving tabindex, and arrow keys move focus AND
 * selection. It earns the pattern because there really are panels being
 * swapped and only the selected one is in the DOM.
 *
 * IDs are derived from the sheet's own instance id (the session header mints it
 * with `useId()`), so two retained session panes can never collide on
 * tab/panel ids.
 */

import { useEffect, useRef, type ReactNode } from 'react';

export interface SheetTabSpec<T extends string> {
  readonly key: T;
  readonly label: string;
  readonly icon?: ReactNode;
}

/**
 * Pure keyboard policy, exported so it unit-tests without a DOM.
 * ArrowLeft/Right step with wrap; Home/End jump to the ends; anything else
 * yields null (the caller leaves the event to the browser).
 */
export function nextDetailsTab<T extends string>(key: string, current: T, order: readonly T[]): T | null {
  const index = order.indexOf(current);
  if (index === -1) return null;
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return order[(index + 1) % order.length] ?? null;
    case 'ArrowLeft':
    case 'ArrowUp':
      return order[(index - 1 + order.length) % order.length] ?? null;
    case 'Home':
      return order[0] ?? null;
    case 'End':
      return order[order.length - 1] ?? null;
    default:
      return null;
  }
}

export const sheetTabId = (sheetId: string, key: string): string => `${sheetId}-tab-${key}`;

export const sheetPanelId = (sheetId: string, key: string): string => `${sheetId}-tabpanel-${key}`;

export interface SheetTabsProps<T extends string> {
  readonly sheetId: string;
  readonly tabs: readonly SheetTabSpec<T>[];
  readonly current: T;
  readonly order: readonly T[];
  readonly onChange: (key: T) => void;
  readonly label?: string;
}

export function SheetTabs<T extends string>({
  sheetId,
  tabs,
  current,
  order,
  onChange,
  label = 'Session details sections',
}: SheetTabsProps<T>) {
  const refs = useRef(new Map<T, HTMLButtonElement>());

  // After a selection change (arrow OR click) the newly selected tab takes
  // focus. There is NO horizontal scroll to correct any more: the four tabs
  // share the strip width as equal columns (`.kt-sheet-tabs` in the design
  // stylesheet), so a real tab strip you never have to scroll — which was the
  // whole point.
  const focusSelected = () => {
    refs.current.get(current)?.focus();
  };

  // Keep focus on the selected tab when selection changes via keyboard, but
  // only pull focus back if a tab in this strip already holds it — never steal
  // focus from the panel or elsewhere on an unrelated re-render.
  useEffect(() => {
    const active = document.activeElement;
    for (const element of refs.current.values()) {
      if (element === active) {
        refs.current.get(current)?.focus();
        break;
      }
    }
  }, [current]);

  return (
    // A real tab strip, not a scroller. The container carries the shared
    // baseline (`border-b`) that the selected tab's accent underline connects
    // to; each tab is an equal-width column (`flex-1`), so four tabs always fit
    // and there is never anything to scroll. The tab idiom itself lives in
    // `.kt-sheet-tabs .kt-tab`: the same `.kt-tab` vocabulary, specialised from
    // a pill into an underlined tab — inactive tabs recede to muted text, the
    // active one takes the accent and the baseline.
    <div role="tablist" aria-label={label} className="kt-sheet-tabs flex items-stretch border-b border-border-soft">
      {tabs.map(tab => {
        const selected = tab.key === current;
        return (
          <button
            key={tab.key}
            ref={element => {
              if (element) refs.current.set(tab.key, element);
              else refs.current.delete(tab.key);
            }}
            type="button"
            role="tab"
            id={sheetTabId(sheetId, tab.key)}
            aria-selected={selected}
            aria-controls={sheetPanelId(sheetId, tab.key)}
            tabIndex={selected ? 0 : -1}
            onClick={() => {
              if (!selected) onChange(tab.key);
            }}
            onKeyDown={event => {
              const next = nextDetailsTab(event.key, tab.key, order);
              if (next === null) return;
              event.preventDefault();
              onChange(next);
              // Focus follows selection; the next render's ref holds the target.
              requestAnimationFrame(focusSelected);
            }}
            className="kt-tab min-w-0 flex-1 justify-center"
          >
            {tab.icon}
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
