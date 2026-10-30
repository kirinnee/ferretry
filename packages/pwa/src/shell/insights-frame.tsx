/**
 * INSIGHTS — Analytics, Warden and Learning as ONE place with three views.
 *
 * The approved session-view redesign gathers the three read-mostly fleet surfaces under one entry at the
 * foot of the sessions bar, so the app's navigation is Projects · Insights · Settings rather than six
 * peer destinations competing for the top of every page. Each view keeps its own address — a link to
 * `/warden` still lands on Warden — and the strip above it is the ordinary level-three underlined tabs.
 *
 * THE GUTTER IS SET HERE, ONCE. A phone gets 16px either side, wider screens the panel padding, and it
 * applies to the tab strip and to the page under it alike, so a page cannot forget it and its edges
 * line up with the tabs. Pages that want the shared column use {@link INSIGHTS_COLUMN_CLASS}: one
 * column, at most 1080px, left-aligned with the tabs rather than centred away from them.
 */

import type { ReactNode } from 'react';
import type { DaemonId } from '../lib/daemon-connection.ts';
import { daemonAnalyticsPath, daemonLearningPath, daemonWardenPath } from '../lib/pages/routes.ts';
import { UnderlineTabs } from './underline-tabs.tsx';
import { PageThemeSwitch } from './theme-toggle.tsx';

export type InsightsView = 'analytics' | 'warden' | 'learning';

/** The one Insights column: full width up to 1080px, flush left with the tabs. */
export const INSIGHTS_COLUMN_CLASS = 'w-full max-w-[1080px]';

/** The frame's side gutter: 16px on a phone, the panel padding from `sm` up. */
const INSIGHTS_GUTTER_CLASS = 'px-4 sm:px-5';

const INSIGHTS_TABS = [
  { id: 'analytics', label: 'Analytics', path: daemonAnalyticsPath },
  { id: 'warden', label: 'Warden', path: daemonWardenPath },
  { id: 'learning', label: 'Learning', path: daemonLearningPath },
] as const;

export interface InsightsFrameProps {
  readonly daemonId: DaemonId;
  readonly current: InsightsView;
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
            onNavigate(INSIGHTS_TABS.find(tab => tab.id === id)?.path(daemonId) ?? daemonAnalyticsPath(daemonId))
          }
          tabs={INSIGHTS_TABS}
        />
        <PageThemeSwitch />
      </div>
      <div className={`flex min-h-0 flex-1 flex-col ${INSIGHTS_GUTTER_CLASS}`} data-insights-body="">
        {children}
      </div>
    </div>
  );
}
