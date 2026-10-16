/**
 * Info for one ferret: the six tabs, each bound to the read that owns its facts.
 *
 * Every read is a port the page binds once (`SessionInfoPorts`), so this file never reaches a daemon
 * and a test hands it exactly the rows a reader sees. A read starts the first time its tab is shown and
 * is kept while the panel stays open, so moving between tabs neither re-reads nor blanks what is there.
 */

import type {
  AnalyticsResponse,
  BrowserPageSummary,
  BrowserStatus,
  ManagedWorktreeView,
  SessionView,
  TerminalListView,
  WardenVerdict,
} from '@ferretry/protocol';
import type { ReactNode } from 'react';
import type { ResolvedQuota } from '../../lib/usage.ts';
import { ContextRailBody, type ContextRailBodyProps } from '../context-rail/context-rail-body.tsx';
import { FERRETRY_TOOLS_SERVER, FOLDER_TABS } from '../context-rail/context-rail-model.ts';
import { useContextRead } from '../context-rail/context-rail-parts.tsx';
import type { ContextLoader } from '../context-rail/context-rail-ports.ts';
import { useContextSignals } from '../context-rail/context-rail-signals.tsx';
import type { ClipboardWriter } from '../onboarding/copy-button.tsx';
import type { SurfaceDriving } from '../workspace/use-surface-driving.ts';
import { InfoOverview } from './info-overview.tsx';
import { InfoPanel } from './info-panel.tsx';
import { type InfoListRead, InfoRuntime } from './info-runtime.tsx';
import { InfoSignals, type InfoVerdictsRead } from './info-signals.tsx';
import { InfoSurfaces } from './info-surfaces.tsx';
import { type InfoAnalyticsRead, InfoUsage } from './info-usage.tsx';
import type { InfoPlacement } from './use-info-placement.ts';

/** The Folder tab's data: the context rail's, minus what Info decides itself. */
export type InfoFolderProps = Omit<ContextRailBodyProps, 'tab' | 'onTabChange' | 'tabs' | 'label'>;

export interface SessionInfoPorts {
  readonly worktrees: ContextLoader<readonly ManagedWorktreeView[]>;
  readonly verdicts: ContextLoader<readonly WardenVerdict[]>;
  readonly analytics: ContextLoader<AnalyticsResponse>;
  readonly folder: InfoFolderProps;
}

export interface SessionInfoProps {
  readonly view: SessionView;
  readonly name: string;
  readonly project: string | null;
  readonly sessions?: readonly SessionView[];
  readonly placement: InfoPlacement;
  /** Phone: the sheet's half/full control is offered. */
  readonly presentation: 'panel' | 'sheet';
  readonly titleId: string;
  readonly ports: SessionInfoPorts;
  readonly quota: ResolvedQuota | null;
  readonly write: ClipboardWriter;
  readonly driving: SurfaceDriving;
  readonly terminals: TerminalListView | null;
  readonly browser: BrowserStatus | null;
  readonly onOpenTerminal: (terminalId: string, label: string) => void;
  readonly onOpenPage: (page: BrowserPageSummary) => void;
  readonly onRename?: () => void;
  readonly onOpenSession?: (sessionId: string) => void;
  readonly onOpenTasks?: () => void;
  readonly onOpenAnalytics?: () => void;
  /** The model and effort pickers, when the host has them (another surface owns them). */
  readonly runtimeControls?: ReactNode;
  readonly now?: () => number;
}

const listRead = <T,>(
  read: ReturnType<typeof useContextRead<T>>['load'],
  items: (value: T) => readonly string[],
): InfoListRead =>
  read.kind === 'ready'
    ? { kind: 'ready', items: items(read.value) }
    : read.kind === 'failed'
      ? { kind: 'failed', reason: read.reason }
      : { kind: 'loading' };

export function SessionInfo({
  view,
  name,
  project,
  sessions,
  placement,
  presentation,
  titleId,
  ports,
  quota,
  write,
  driving,
  terminals,
  browser,
  onOpenTerminal,
  onOpenPage,
  onRename,
  onOpenSession,
  onOpenTasks,
  onOpenAnalytics,
  runtimeControls,
  now = Date.now,
}: SessionInfoProps) {
  const { tab } = placement;
  const worktrees = useContextRead(ports.worktrees, tab === 'overview');
  const verdicts = useContextRead(ports.verdicts, tab === 'signals');
  const analytics = useContextRead(ports.analytics, tab === 'usage');
  const mcp = useContextRead(ports.folder.loadMcp, tab === 'runtime');
  const docs = useContextRead(ports.folder.loadDocs, tab === 'runtime');
  const skills = useContextRead(ports.folder.loadSkills, tab === 'runtime');
  const signals = useContextSignals(ports.folder.signals);

  const verdictsRead: InfoVerdictsRead =
    verdicts.load.kind === 'ready'
      ? { kind: 'ready', verdicts: verdicts.load.value }
      : verdicts.load.kind === 'failed'
        ? { kind: 'failed', reason: verdicts.load.reason }
        : { kind: 'loading' };
  const analyticsRead: InfoAnalyticsRead =
    analytics.load.kind === 'ready'
      ? { kind: 'ready', response: analytics.load.value }
      : analytics.load.kind === 'failed'
        ? { kind: 'failed', reason: analytics.load.reason }
        : { kind: 'loading' };

  return (
    <InfoPanel
      name={name}
      onClose={placement.close}
      onTabChange={placement.setTab}
      openSignals={signals.snapshot?.count ?? 0}
      tab={tab}
      titleId={titleId}
      {...(presentation === 'sheet' ? { sheetSize: placement.sheetSize, onSheetSizeChange: placement.setSheetSize } : {})}
      render={{
        overview: () => (
          <InfoOverview
            name={name}
            now={now()}
            project={project}
            view={view}
            worktrees={worktrees.load.kind === 'ready' ? worktrees.load.value : null}
            write={write}
            {...(sessions === undefined ? {} : { sessions })}
            {...(onRename === undefined ? {} : { onRename })}
            {...(onOpenSession === undefined ? {} : { onOpenSession })}
            {...(onOpenTasks === undefined ? {} : { onOpenTasks })}
          />
        ),
        runtime: () => (
          <InfoRuntime
            instructions={listRead(docs.load, value => value.map(doc => doc.name))}
            mcp={listRead(mcp.load, value =>
              value.filter(server => server.name !== FERRETRY_TOOLS_SERVER || server.scope !== 'ferretry').map(server => server.name),
            )}
            skills={skills.load.kind === 'ready' ? skills.load.value.skills.length : null}
            view={view}
            {...(runtimeControls === undefined ? {} : { controls: runtimeControls })}
          />
        ),
        usage: () => (
          <InfoUsage
            analytics={analyticsRead}
            now={now()}
            quota={quota}
            view={view}
            {...(onOpenAnalytics === undefined ? {} : { onOpenAnalytics })}
          />
        ),
        folder: () => (
          <ContextRailBody
            {...ports.folder}
            label="Folder sections"
            onTabChange={placement.setFolderTab}
            tab={placement.folderTab}
            tabs={FOLDER_TABS}
          />
        ),
        signals: () => (
          <InfoSignals
            agentName={name}
            now={now}
            port={ports.folder.signals}
            sessionId={view.config.id}
            verdicts={verdictsRead}
          />
        ),
        surfaces: () => (
          <InfoSurfaces
              agentName={name}
              browser={browser}
              driving={driving}
              onOpenPage={onOpenPage}
              onOpenTerminal={onOpenTerminal}
              terminals={terminals}
            />
        ),
      }}
    />
  );
}
