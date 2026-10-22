/** Group/table scaffolds for the sessions dashboard; leaf markup lives in the row module. */

import { FolderGit2 } from 'lucide-react';
import type { PickerAccount } from '../lib/account-picker-catalog.ts';
import type { DashboardView, Density } from '../lib/controls.ts';
import type { DaemonId } from '../lib/daemon-connection.ts';
import type { SessionGroup } from '../lib/fleet-grouping.ts';
import type { SessionQuotaResolver } from '../lib/usage.ts';
import {
  DENSITY_COLUMN_LABELS,
  DENSITY_COLUMN_WIDTHS,
  dashboardTone,
  groupHueVar,
  groupHueVars,
  hoistedStatus,
  routineStatus,
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
  readonly usage: SessionQuotaResolver | null;
  /** The daemon's account roster; `null` (unread) names no account. */
  readonly accounts?: readonly PickerAccount[] | null;
  readonly now: number;
}

/** Full cards or the original six-column fixed table. */
export function FullDensityGroups({
  daemonId,
  groups,
  mode,
  scoped,
  usage,
  accounts = null,
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
            <div className="grid grid-cols-[minmax(0,1fr)] gap-2.5 sm:gap-1.5">
              {group.rows.map(view => (
                <SessionCard
                  daemonId={daemonId}
                  key={`${daemonId}:${view.config.id}`}
                  now={now}
                  onNavigate={onNavigate}
                  usage={usage}
                  accounts={accounts}
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
                      accounts={accounts}
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
  /** Injected clock for each row's age. */
  readonly now: number;
}

/** Compact/minimal groups use either a dense table or one shared phone panel. */
export function LeanDensityGroups({
  daemonId,
  groups,
  mode,
  density,
  scoped,
  now,
  onFocus,
  onNavigate,
}: LeanDensityGroupsProps) {
  const labels = DENSITY_COLUMN_LABELS[density];
  const widths = DENSITY_COLUMN_WIDTHS[density];
  const hues = groupHueVars(groups);
  return (
    <div className="fy-session-groups">
      {groups.map((group, index) =>
        mode === 'cards' ? (
          <LeanGroupPanel
            daemonId={daemonId}
            density={density}
            group={group}
            hue={hues[index] ?? groupHueVar(group.path || group.name)}
            key={group.path || group.name}
            now={now}
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
  readonly now: number;
}

/**
 * One project: a small heading (folder, name, a muted count) OVER one container of its sessions, a
 * hairline between them. The heading sits on the page, not in a box of its own, so a project is one
 * frame rather than a box with a ruled header box inside it — the sessions are the content. The
 * container is the theme's panel, so Neo's heavy frame and offset shadow land once per project and
 * never on a row (session-screens.css "SESSION GROUPS").
 */
export function LeanGroupPanel({
  daemonId,
  group,
  hue,
  density,
  scoped,
  now,
  onFocus,
  onNavigate,
}: LeanGroupPanelProps) {
  const found = !scoped && density === 'compact' ? hoistedStatus(group.rows) : null;
  // A hoisted "run" is the routine again, said once for the whole folder: the dots already say it.
  const hoisted = found !== null && routineStatus(found.status) ? null : found;
  return (
    <section aria-label={`Sessions in ${group.name}`} className="fy-session-group">
      {!scoped && (
        <button
          aria-label={`Focus folder ${group.name}`}
          className="fy-session-group__head"
          onClick={() => onFocus(group.path)}
          title={`Focus folder ${group.name}`}
          type="button"
        >
          <FolderGit2 aria-hidden="true" className="shrink-0" size={13} style={{ color: hue }} />
          <span className="min-w-0 truncate text-ui font-semibold text-fg">{group.name}</span>
          <span className="mono shrink-0 text-meta text-faint">{group.rows.length}</span>
          {group.path && (
            <span className="mono hidden min-w-0 truncate text-meta text-faint sm:inline">{group.path}</span>
          )}
          {hoisted && (
            <span
              className="ml-auto shrink-0 text-meta font-medium"
              style={{ color: `var(--${dashboardTone(hoisted.status)})` }}
              title={hoisted.status}
            >
              {hoisted.uniform ? statusWord(hoisted.status) : `${hoisted.count}× ${statusWord(hoisted.status)}`}
            </span>
          )}
        </button>
      )}
      <div className="kt-panel fy-session-group__list">
        {group.rows.map(view => (
          <LeanSessionCard
            daemonId={daemonId}
            density={density}
            key={`${daemonId}:${view.config.id}`}
            now={now}
            onNavigate={onNavigate}
            statusHoisted={hoisted !== null && view.state.status === hoisted.status}
            view={view}
          />
        ))}
      </div>
    </section>
  );
}
