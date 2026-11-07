/**
 * INSIGHTS — Insights and Warden as ONE place with two views.
 *
 * The approved session-view redesign gathers the read-mostly fleet surfaces under one entry, so the app's
 * navigation is not a row of peer destinations competing for the top of every page. Each view keeps its own
 * address — a link to `/warden` still lands on Warden — and the strip above it is the ordinary level-three
 * underlined tabs. (Today's third tab, Learning, has no screen of its own in 5.0: Lessons is a panel.)
 *
 * THE GUTTER IS SET HERE, ONCE. A phone gets 16px either side, wider screens the panel padding, and it
 * applies to the tab strip and to the page under it alike, so a page cannot forget it and its edges
 * line up with the tabs. Pages that want the shared column use {@link INSIGHTS_COLUMN_CLASS}: one
 * column, at most 1080px, left-aligned with the tabs rather than centred away from them.
 *
 * The page-level theme switch that sat beside the tabs is the shell's now (§5.2, a device setting).
 */

import { UnderlineTabs } from '@ferretry/app/ui';
import type { ReactNode } from 'react';
import { type DaemonId, daemonInsightsPath } from '../shell.ts';

type InsightsFrameView = 'insights' | 'warden';

/** The one Insights column: full width up to 1080px, flush left with the tabs. */
export const INSIGHTS_COLUMN_CLASS = 'w-full max-w-[1080px]';

/** The frame's side gutter: 16px on a phone, the panel padding from `sm` up. */
const INSIGHTS_GUTTER_CLASS = 'px-4 sm:px-5';

/** Warden's screen (`/warden` in its manifest), addressed under a daemon. */
const daemonWardenPath = (id: DaemonId): string => `/d/${encodeURIComponent(id)}/warden`;

const INSIGHTS_TABS = [
  { id: 'insights', label: 'Insights', path: daemonInsightsPath },
  { id: 'warden', label: 'Warden', path: daemonWardenPath },
] as const;

export interface InsightsFrameProps {
  readonly daemonId: DaemonId;
  readonly current: InsightsFrameView;
  readonly onNavigate: (to: string) => void;
  readonly children: ReactNode;
}

export function InsightsFrame({ daemonId, current, onNavigate, children }: InsightsFrameProps) {
  return (
    <div className="flex h-full min-h-0 w-full flex-col" data-insights={current}>
      <div className={`flex shrink-0 items-end gap-2 pt-2 ${INSIGHTS_GUTTER_CLASS}`}>
        <h1 className="sr-only">Insights</h1>
        <UnderlineTabs
          className="min-w-0 flex-1"
          current={current}
          label="Insights"
          marker="data-insights-tab"
          onSelect={id =>
            onNavigate(INSIGHTS_TABS.find(tab => tab.id === id)?.path(daemonId) ?? daemonInsightsPath(daemonId))
          }
          tabs={INSIGHTS_TABS}
        />
      </div>
      <div className={`flex min-h-0 flex-1 flex-col ${INSIGHTS_GUTTER_CLASS}`} data-insights-body="">
        {children}
      </div>
    </div>
  );
}
