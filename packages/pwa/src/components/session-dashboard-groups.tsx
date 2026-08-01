/** Group/table scaffolds for the sessions dashboard; leaf markup lives in the row module. */

import { FolderGit2 } from 'lucide-react';
import { cn } from '../lib/class-names.ts';
import type { DashboardView, Density } from '../lib/controls.ts';
import type { DaemonId } from '../lib/daemon-connection.ts';
import type { SessionGroup } from '../lib/fleet-grouping.ts';
import type { DaemonUsageIndex } from '../lib/usage.ts';
import { Badge } from '../shell/primitives.tsx';
import {
  DENSITY_COLUMN_LABELS,
  DENSITY_COLUMN_WIDTHS,
  dashboardTone,
  groupHueVar,
  groupHueVars,
  hoistedStatus,
  statusWord,
} from './session-dashboard-model.ts';
import {
  LeanSessionCard,
  LeanSessionRow,
  ProjectHeading,
  SessionCard,
  SessionRow,
  Th,
} from './session-dashboard-rows.tsx';

interface NavigationProps {
  readonly daemonId: DaemonId;
  readonly onFocus: (path: string) => void;
  readonly onNavigate?: (path: string) => void;
}

export interface FullDensityGroupsProps extends NavigationProps {
  readonly groups: readonly SessionGroup[];
  readonly mode: DashboardView;
  readonly scoped: boolean;
  readonly usage: DaemonUsageIndex | null;
  readonly now: number;
}

/** Full cards or the original six-column fixed table. */
export function FullDensityGroups({
  daemonId,
  groups,
  mode,
  scoped,
  usage,
  now,
  onFocus,
  onNavigate,
}: FullDensityGroupsProps) {
  const labels = DENSITY_COLUMN_LABELS.full;
  const widths = DENSITY_COLUMN_WIDTHS.full;
  return (
    <div className="space-y-3">
      {groups.map(group => (
        <section key={group.path || group.name}>
          {!scoped && <ProjectHeading group={group} onFocus={onFocus} />}
          {mode === 'cards' ? (
            <div className="grid gap-2.5 sm:gap-1.5">
              {group.rows.map(view => (
                <SessionCard
                  daemonId={daemonId}
                  key={`${daemonId}:${view.config.id}`}
                  now={now}
                  onNavigate={onNavigate}
                  usage={usage}
                  view={view}
                />
              ))}
            </div>
          ) : (
            <div className="kt-panel overflow-x-auto">
              <table className="min-w-[900px] w-full table-fixed border-collapse">
                <caption className="sr-only">Sessions in {group.name}</caption>
                <thead>
                  <tr>
                    {labels.map((label, index) => (
                      <Th className={widths[index] ?? ''} key={label}>
                        {label}
                      </Th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {group.rows.map(view => (
                    <SessionRow
                      daemonId={daemonId}
                      key={`${daemonId}:${view.config.id}`}
                      now={now}
                      onNavigate={onNavigate}
                      usage={usage}
                      view={view}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

export interface LeanDensityGroupsProps extends NavigationProps {
  readonly groups: readonly SessionGroup[];
  readonly mode: DashboardView;
  readonly density: Exclude<Density, 'full'>;
  readonly scoped: boolean;
}

/** Compact/minimal groups use either a dense table or one shared phone panel. */
export function LeanDensityGroups({
  daemonId,
  groups,
  mode,
  density,
  scoped,
  onFocus,
  onNavigate,
}: LeanDensityGroupsProps) {
  const labels = DENSITY_COLUMN_LABELS[density];
  const widths = DENSITY_COLUMN_WIDTHS[density];
  const hues = groupHueVars(groups);
  return (
    <div className="space-y-3">
      {groups.map((group, index) =>
        mode === 'cards' ? (
          <LeanGroupPanel
            daemonId={daemonId}
            density={density}
            group={group}
            hue={hues[index] ?? groupHueVar(group.path || group.name)}
            key={group.path || group.name}
            onFocus={onFocus}
            onNavigate={onNavigate}
            scoped={scoped}
          />
        ) : (
          <section key={group.path || group.name}>
            {!scoped && <ProjectHeading group={group} onFocus={onFocus} />}
            <div className="kt-panel">
              <table className="w-full table-fixed border-collapse">
                <caption className="sr-only">Sessions in {group.name}</caption>
                <thead>
                  <tr>
                    {labels.map((label, column) => (
                      <Th className={widths[column] ?? ''} key={label}>
                        {label}
                      </Th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {group.rows.map(view => (
                    <LeanSessionRow
                      daemonId={daemonId}
                      density={density}
                      key={`${daemonId}:${view.config.id}`}
                      onNavigate={onNavigate}
                      view={view}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ),
      )}
    </div>
  );
}

export interface LeanGroupPanelProps extends NavigationProps {
  readonly group: SessionGroup;
  readonly hue: string;
  readonly density: Exclude<Density, 'full'>;
  readonly scoped: boolean;
}

/** One hue-railed project panel with a hoisted majority status where visible. */
export function LeanGroupPanel({ daemonId, group, hue, density, scoped, onFocus, onNavigate }: LeanGroupPanelProps) {
  const hoisted = !scoped && density === 'compact' ? hoistedStatus(group.rows) : null;
  return (
    <section className="kt-panel overflow-hidden" style={{ borderLeftWidth: 3, borderLeftColor: hue }}>
      {!scoped && (
        <button
          aria-label={`Focus folder ${group.name}`}
          className="kt-panel__header min-h-[44px] w-full min-w-0 text-left hover:bg-surface-2"
          onClick={() => onFocus(group.path)}
          title={`Focus folder ${group.name}`}
          type="button"
        >
          <FolderGit2 aria-hidden="true" className="shrink-0" size={13} style={{ color: hue }} />
          <span className="min-w-0 truncate text-ui font-semibold text-fg">{group.name}</span>
          {group.path && (
            <span className="mono hidden min-w-0 truncate text-meta text-faint sm:inline">{group.path}</span>
          )}
          {hoisted && (
            <Badge className="ml-auto shrink-0" title={hoisted.status} tone={dashboardTone(hoisted.status)}>
              {hoisted.uniform ? statusWord(hoisted.status) : `${hoisted.count}× ${statusWord(hoisted.status)}`}
            </Badge>
          )}
          <span className={cn('mono shrink-0 text-meta text-faint', !hoisted && 'ml-auto')}>{group.rows.length}</span>
        </button>
      )}
      <div className="divide-y divide-border-soft">
        {group.rows.map(view => (
          <LeanSessionCard
            daemonId={daemonId}
            density={density}
            key={`${daemonId}:${view.config.id}`}
            onNavigate={onNavigate}
            statusHoisted={hoisted !== null && view.state.status === hoisted.status}
            view={view}
          />
        ))}
      </div>
    </section>
  );
}
