/**
 * INSIGHTS — Analytics, Warden and Learning as ONE place with three views.
 *
 * The approved session-view redesign gathers the three read-mostly fleet surfaces under one entry at the
 * foot of the sessions bar, so the app's navigation is Projects · Insights · Settings rather than six
 * peer destinations competing for the top of every page. Each view keeps its own address — a link to
 * `/warden` still lands on Warden — and the strip above it is the ordinary level-three underlined tabs.
 */

import type { ReactNode } from 'react';
import type { DaemonId } from '../lib/daemon-connection.ts';
import { daemonAnalyticsPath, daemonLearningPath, daemonWardenPath } from '../lib/pages/routes.ts';
import { UnderlineTabs } from './underline-tabs.tsx';

export type InsightsView = 'analytics' | 'warden' | 'learning';

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
      <div className="shrink-0 px-2 pt-2 sm:px-5">
        <h1 className="sr-only">Insights</h1>
        <UnderlineTabs
          current={current}
          label="Insights"
          marker="data-insights-tab"
          onSelect={id => onNavigate(INSIGHTS_TABS.find(tab => tab.id === id)?.path(daemonId) ?? daemonAnalyticsPath(daemonId))}
          tabs={INSIGHTS_TABS}
        />
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
