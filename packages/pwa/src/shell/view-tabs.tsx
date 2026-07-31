/**
 * The small segmented control that switches between views on a page (Chat |
 * Terminal on the session page). Ported from kteam `ui/src/components/ViewTabs.tsx`.
 */

import type { ReactNode } from 'react';
import { cn } from '../lib/class-names.ts';

export interface TabSpec<Id extends string> {
  readonly id: Id;
  readonly label: string;
  readonly icon?: ReactNode;
}

export interface ViewTabsProps<Id extends string> {
  readonly tabs: readonly TabSpec<Id>[];
  readonly current: Id;
  readonly onChange: (id: Id) => void;
  readonly className?: string;
  /** Accessible name for the button group. */
  readonly label?: string;
}

/**
 * This is a view-mode switcher, NOT a WAI-ARIA tab pattern: the buttons do not
 * own `role="tabpanel"` regions and there is no roving tabindex, so claiming
 * `role="tablist"`/`role="tab"` made assistive tech announce "tab 1 of 3" and
 * then arrow keys did nothing (a11y report M-2). It is an honest labelled group
 * of toggle buttons instead — each carries `aria-pressed`, and native
 * Tab/Space/Enter is then exactly right. Selection visuals are unchanged:
 * `.kt-tab` keys its selected treatment off `[aria-pressed='true']` as well as
 * `[aria-selected]`.
 */
export function ViewTabs<Id extends string>({
  tabs,
  current,
  onChange,
  className,
  label = 'View mode',
}: ViewTabsProps<Id>) {
  return (
    // The track keeps its own geometry; each tab is `.kt-tab`, which owns the
    // height, padding, radius, casing, font and selected treatment per theme.
    //
    // kteam wrote this as `<div role="group">`. A native <fieldset> carries the
    // same implicit role and satisfies the repo's a11y gate without an explicit
    // role attribute; Tailwind's preflight zeroes fieldset margin, padding and
    // border, so the rendered box is unchanged.
    <fieldset
      aria-label={label}
      className={cn('inline-flex items-center rounded-control border border-border bg-surface-2 p-0.5', className)}
    >
      {tabs.map(tab => (
        <button
          key={tab.id}
          type="button"
          aria-pressed={tab.id === current}
          onClick={() => onChange(tab.id)}
          className="kt-tab justify-center"
        >
          {tab.icon}
          {tab.label}
        </button>
      ))}
    </fieldset>
  );
}
