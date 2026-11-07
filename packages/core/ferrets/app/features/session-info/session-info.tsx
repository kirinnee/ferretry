/**
 * Info for one ferret: the seven tabs, each bound to the read that owns its facts.
 *
 * Every read is a port the page binds once (`SessionInfoPorts`), so this file never reaches a daemon
 * and a test hands it exactly the rows a reader sees. A read starts the first time its tab is shown and
 * is kept while the panel stays open, so moving between tabs neither re-reads nor blanks what is there.
 */

import type { AnalyticsResponse, LimitsView, ManagedWorktreeView, WardenVerdict } from '@ferretry/protocol';
import type { SessionRelaunchSettings, SessionView } from '../../../contract/index.ts';
import type { ReactNode } from 'react';
import type { ResolvedQuota } from '../../../../../plugins/usage/app/lib/usage.ts';
import { ContextRailBody, type ContextRailBodyProps } from '../../../../../plugins/conversation/app/features/context-rail/context-rail-body.tsx';
import { FOLDER_TABS, loadedSkillCount } from '../../../../../plugins/conversation/app/features/context-rail/context-rail-model.ts';
import { useContextRead } from '../../../../../plugins/conversation/app/features/context-rail/context-rail-parts.tsx';
import type { ContextLoader } from '../../../../../plugins/conversation/app/features/context-rail/context-rail-ports.ts';
import type { ClipboardWriter } from '../../../../../plugins/onboarding/app/features/onboarding/copy-button.tsx';
import type { InfoAboutProps } from './info-about.tsx';
import { INFO_TABS, INFO_TABS_WITHOUT_BOARD } from './info-model.ts';
import { InfoOverview } from './info-overview.tsx';
import { InfoPanel } from './info-panel.tsx';
import type { InfoRelaunchRead } from './info-relaunch.tsx';
import { type InfoListRead, InfoRuntime } from './info-runtime.tsx';
import { type InfoAnalyticsRead, InfoUsage } from './info-usage.tsx';
import { type InfoVerdictsRead, InfoWarden } from './info-warden.tsx';
import { memoryNote } from './memory-note.ts';
import type { InfoPlacement } from './use-info-placement.ts';

/** The Context tab's data: the context rail's, minus what Info decides itself. */
type InfoFolderProps = Omit<ContextRailBodyProps, 'tab' | 'onTabChange' | 'tabs' | 'label'>;

export interface SessionInfoPorts {
  readonly worktrees: ContextLoader<readonly ManagedWorktreeView[]>;
  readonly verdicts: ContextLoader<readonly WardenVerdict[]>;
  readonly analytics: ContextLoader<AnalyticsResponse>;
  readonly folder: InfoFolderProps;
  /** Whether a Restart would relaunch this ferret on different settings. Absent: no Settings row. */
  readonly relaunch?: ContextLoader<SessionRelaunchSettings>;
  /** What ferret limits are in force and who is being slowed or stopped for memory. Absent: no Memory row. */
  readonly limits?: ContextLoader<LimitsView>;
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
  readonly onRename?: () => void;
  readonly onOpenSession?: (sessionId: string) => void;
  /** This ferret's card, when the host has a board: the Overview's Card row and the Tasks tab. */
  readonly card?: NonNullable<InfoAboutProps['card']> & { readonly tasks: ReactNode };
  /** The capability switches, Restart and agenda line of Overview's "About this ferret" block. */
  readonly about?: Pick<InfoAboutProps, 'switches' | 'onRestart' | 'agenda'>;
  /** The Agenda tab's body (`useAgenda().tab`). Absent or `null`: this ferret has no agenda, and no tab is offered. */
  readonly agendaTab?: ReactNode;
  readonly onOpenAnalytics?: () => void;
  /** The model and effort pickers, when the host has them (another surface owns them). */
  readonly runtimeControls?: ReactNode;
  /** Whether this ferret is instructed to learn (see `InfoRuntimeProps.learning`). Absent: no Learning row. */
  readonly learning?: boolean | null;
  /** The same Restart as Actions › Restart CLI, offered where the Settings row says it is behind. */
  readonly onRestart?: () => Promise<void>;
  readonly now?: () => number;
}

/** A failure in words a person can read: a raw parse dump says nothing to them. */
export const readableReason = (reason: string): string =>
  reason.length > 160 || /^\s*[[{]/u.test(reason) ? 'the daemon answered with something this page cannot read' : reason;

const listRead = <T,>(
  read: ReturnType<typeof useContextRead<T>>['load'],
  items: (value: T) => readonly string[],
): InfoListRead =>
  read.kind === 'ready'
    ? { kind: 'ready', items: items(read.value) }
    : read.kind === 'failed'
      ? { kind: 'failed', reason: readableReason(read.reason) }
      : { kind: 'loading' };

/** The loader a host without the read binds, so the hook order never depends on the port. */
const NO_LIMITS: ContextLoader<LimitsView> = async () => await Promise.reject(new Error('no limits read'));

const NO_RELAUNCH: ContextLoader<SessionRelaunchSettings> = async () => ({ current: true, reasons: [] });

const relaunchRead = (read: ReturnType<typeof useContextRead<SessionRelaunchSettings>>['load']): InfoRelaunchRead =>
  read.kind === 'ready'
    ? { kind: 'ready', settings: read.value }
    : read.kind === 'failed'
      ? { kind: 'failed', reason: readableReason(read.reason) }
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
  onRename,
  onOpenSession,
  card,
  about,
  agendaTab,
  onOpenAnalytics,
  runtimeControls,
  learning,
  onRestart,
  now = Date.now,
}: SessionInfoProps) {
  const { tab } = placement;
  const worktrees = useContextRead(ports.worktrees, tab === 'overview');
  const verdicts = useContextRead(ports.verdicts, tab === 'overview');
  const analytics = useContextRead(ports.analytics, tab === 'usage');
  const mcp = useContextRead(ports.folder.loadMcp, tab === 'runtime');
  const docs = useContextRead(ports.folder.loadDocs, tab === 'runtime');
  const skills = useContextRead(ports.folder.loadSkills, tab === 'runtime');
  const limits = useContextRead(ports.limits ?? NO_LIMITS, tab === 'overview' && ports.limits !== undefined);
  const memory = limits.load.kind === 'ready' ? memoryNote(limits.load.value, view.config.id) : null;
  const aboutWithMemory =
    about === undefined && memory === null ? undefined : { ...about, ...(memory === null ? {} : { memory }) };
  const relaunch = useContextRead(ports.relaunch ?? NO_RELAUNCH, tab === 'runtime' && ports.relaunch !== undefined);

  const verdictsRead: InfoVerdictsRead =
    verdicts.load.kind === 'ready'
      ? { kind: 'ready', verdicts: verdicts.load.value }
      : verdicts.load.kind === 'failed'
        ? { kind: 'failed', reason: readableReason(verdicts.load.reason) }
        : { kind: 'loading' };
  const analyticsRead: InfoAnalyticsRead =
    analytics.load.kind === 'ready'
      ? { kind: 'ready', response: analytics.load.value }
      : analytics.load.kind === 'failed'
        ? { kind: 'failed', reason: readableReason(analytics.load.reason) }
        : { kind: 'loading' };

  return (
    <InfoPanel
      name={name}
      onClose={placement.close}
      onTabChange={placement.setTab}
      tab={tab}
      titleId={titleId}
      tabs={(card === undefined ? INFO_TABS_WITHOUT_BOARD : INFO_TABS).filter(
        each => each !== 'agenda' || (agendaTab !== undefined && agendaTab !== null),
      )}
      {...(presentation === 'sheet'
        ? { sheetSize: placement.sheetSize, onSheetSizeChange: placement.setSheetSize }
        : {})}
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
            {...(card === undefined
              ? {}
              : {
                  card: {
                    chip: card.chip,
                    onOpen: card.onOpen,
                    ...(card.onOpenBoard === undefined ? {} : { onOpenBoard: card.onOpenBoard }),
                  },
                })}
            {...(aboutWithMemory === undefined ? {} : { about: aboutWithMemory })}
            warden={<InfoWarden agentName={name} now={now} sessionId={view.config.id} verdicts={verdictsRead} />}
          />
        ),
        agenda: () => agendaTab ?? null,
        tasks: () => card?.tasks ?? null,
        runtime: () => (
          <InfoRuntime
            instructions={listRead(docs.load, value => value.map(doc => doc.name))}
            mcp={listRead(mcp.load, value =>
              value.servers
                .filter(server => server.scope !== 'ferretry' && server.shadowedBy === undefined)
                .map(server => server.name),
            )}
            skills={skills.load.kind === 'ready' ? loadedSkillCount(skills.load.value.skills) : null}
            view={view}
            {...(runtimeControls === undefined ? {} : { controls: runtimeControls })}
            {...(learning === undefined ? {} : { learning })}
            {...(ports.relaunch === undefined ? {} : { relaunch: relaunchRead(relaunch.load) })}
            {...(onRestart === undefined
              ? {}
              : {
                  onRestart: async () => {
                    await onRestart();
                    relaunch.reload();
                  },
                })}
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
            label="Context sections"
            onTabChange={placement.setFolderTab}
            tab={placement.folderTab}
            tabs={FOLDER_TABS}
          />
        ),
      }}
    />
  );
}
