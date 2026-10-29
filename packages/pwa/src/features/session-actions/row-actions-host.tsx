/**
 * THE SESSIONS BAR'S ROW ACTIONS, for whichever ferret was pressed — on any machine the bar lists.
 *
 * It composes exactly what the session header's Actions ▾ composes: `CORE_SESSION_ACTIONS` plus the
 * Warden, Learning, Hypermedia and Pack contributions, each built for the pressed ferret's OWN machine
 * (the connection of the row, not the page's). The only entries that are the row's own are the two a
 * header never needs: Open, and Copy session name.
 *
 * IT OUTLIVES ITS MENU. Choosing "Scan this ferret…" closes the menu and opens a dialog that belongs to
 * the Learning host; a toggle's status line belongs to its host too. So the sidebar keeps this mounted
 * for the last pressed ferret and only `open` says whether the menu is on screen.
 */

import type { SessionView } from '@ferretry/protocol';
import { Copy, MessageSquare } from 'lucide-react';
import { type ReactNode, useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { MigrateSheet } from '../../components/migrate-sheet.tsx';
import { sessionDisplayName } from '../../components/session-top-bar.tsx';
import { useAccountPickerSlice } from '../../hooks/use-account-picker.ts';
import { useKnownProjects } from '../../hooks/use-projects.ts';
import type { DaemonConnection, DaemonId } from '../../lib/daemon-connection.ts';
import { daemonSessionScope } from '../../lib/daemon-scope.ts';
import { daemonLearningPath, daemonSessionPath } from '../../lib/pages/routes.ts';
import { useAppStore, useConnectionSnapshot, useDaemonClient, useDaemonFetch } from '../../lib/store.tsx';
import type { MenuAnchor } from '../../shell/context-menu.tsx';
import type { SessionMenuState } from '../../shell/session-menu-context.ts';
import { useAgendaSessionActions } from '../agenda/agenda-session-actions.tsx';
import { useHypermediaSessionActions } from '../hypermedia/hypermedia-session-actions.tsx';
import { useLearningSessionActions } from '../learning/learning-session-actions.tsx';
import { usePackSessionActions } from '../pack/pack-session-actions.tsx';
import { useAskWardenActions } from '../warden/ask-warden.tsx';
import { ActionToast } from './action-toast.tsx';
import { ContextActionsMenu } from './context-actions-menu.tsx';
import { CORE_SESSION_ACTIONS, type CoreActionContext } from './core-actions.ts';
import { ForkForm } from './fork-form.tsx';
import { type SessionActionContribution, sessionActionSections } from './registry.ts';
import { RenameForm } from './rename-form.tsx';
import { useRestartRefusal } from './restart-refusal.tsx';
import { forkThroughLatest, restartOnEarlierConversation, restartWithResume } from './session-operations.ts';
import { useConvertAction } from './use-convert-action.tsx';

const ROW_ACTION_IDS = { open: 'open', copyName: 'copy-name' } as const;

/** The browser's clipboard, or a refusal a reader can be told about. */
const copyToClipboard = async (text: string): Promise<void> => {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (clipboard === undefined) throw new Error('this browser offers no clipboard here');
  await clipboard.writeText(text);
};

const failureText = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason));

export interface SessionRowActionsHostProps {
  readonly view: SessionView;
  readonly daemonId: DaemonId;
  readonly anchor: MenuAnchor;
  /** A touch press: the menu is a bottom sheet. */
  readonly touch: boolean;
  /** Whether the menu is on screen. The hosts' dialogs and status lines outlive it. */
  readonly open: boolean;
  readonly onClose: (restoreFocus: boolean) => void;
  readonly onNavigate: (to: string) => void;
}

/** What the sessions bar draws for an open row menu: this host, remounted for each ferret pressed. */
export const sessionRowMenuRenderer =
  (onNavigate: (to: string) => void) =>
  (menu: SessionMenuState, close: (restoreFocus: boolean) => void): ReactNode => (
    <SessionRowActionsHost
      anchor={{ x: menu.x, y: menu.y }}
      daemonId={menu.daemonId}
      key={`${menu.daemonId}:${menu.view.config.id}`}
      onClose={close}
      onNavigate={onNavigate}
      open={menu.open}
      touch={menu.touch}
      view={menu.view}
    />
  );

export function SessionRowActionsHost(props: SessionRowActionsHostProps) {
  const { connections } = useConnectionSnapshot();
  const connection = connections.find(candidate => candidate.daemonId === props.daemonId);
  return connection === undefined ? null : <RowActions {...props} connection={connection} />;
}

function RowActions({
  view,
  daemonId,
  anchor,
  touch,
  open,
  onClose,
  onNavigate,
  connection,
}: SessionRowActionsHostProps & { readonly connection: DaemonConnection }) {
  const store = useAppStore();
  const routedClient = useDaemonClient();
  const fetcher = useDaemonFetch();
  const fleet = useSyncExternalStore(
    listener => store.fleet.subscribe(listener),
    () => store.fleet.getSnapshot(),
  );
  const slice = fleet.daemons.get(daemonId);
  const projects = useKnownProjects(store.projects, daemonId);
  const accounts = useAccountPickerSlice(store.accountPicker, connection).catalog?.accounts ?? null;
  const warden = useAskWardenActions(connection);
  const learning = useLearningSessionActions({
    connection,
    fetcher,
    sessions: slice?.sessions ?? null,
    projects,
    accounts,
    onViewLearning: () => onNavigate(daemonLearningPath(daemonId)),
  });
  const hypermedia = useHypermediaSessionActions({ connection, fetcher });
  const pack = usePackSessionActions({ connection, fetcher });
  const agenda = useAgendaSessionActions({ connection, fetcher });
  const [notice, setNotice] = useState<string | null>(null);
  const [migrateOpen, setMigrateOpen] = useState(false);
  const dismissNotice = useCallback(() => setNotice(null), []);

  const name = sessionDisplayName(view);
  const sessionId = view.config.id;
  const publish = (next: SessionView): void => {
    store.fleet.upsertSession(daemonId, next);
  };
  const restartRefusal = useRestartRefusal(publish, sessionId);
  const convert = useConvertAction({
    connection,
    scope: daemonSessionScope(connection, sessionId),
    view,
    canControl: true,
    accountPicker: store.accountPicker,
    onMoved: (moved, sentence) => {
      publish(moved);
      setNotice(sentence);
    },
  });
  const copy = useCallback((text: string, what: string): void => {
    setNotice(null);
    copyToClipboard(text).catch((reason: unknown) => setNotice(`could not copy the ${what}: ${failureText(reason)}`));
  }, []);

  const rowContributions = useMemo<readonly SessionActionContribution<CoreActionContext>[]>(
    () => [
      {
        group: 'session',
        order: 5,
        build: context => ({
          kind: 'run',
          id: ROW_ACTION_IDS.open,
          label: 'Open',
          icon: MessageSquare,
          run: () => onNavigate(daemonSessionPath(daemonId, context.view.config.id)),
        }),
      },
      {
        group: 'session',
        order: 35,
        build: context => ({
          kind: 'run',
          id: ROW_ACTION_IDS.copyName,
          label: 'Copy session name',
          icon: Copy,
          run: () => copy(context.name, 'session name'),
        }),
      },
    ],
    [copy, daemonId, onNavigate],
  );

  const context: CoreActionContext = {
    view,
    name,
    canControl: true,
    copyId: () => copy(sessionId, 'session id'),
    openMigrate: () => setMigrateOpen(true),
    ...(convert.openConvert === undefined ? {} : { openConvert: convert.openConvert }),
    restart: async () => {
      publish(
        await restartWithResume(
          await routedClient(connection),
          view,
          `restart-${sessionId}-${view.state.turn}-${Date.now()}`,
        ),
      );
    },
    restartOnEarlierConversation: async () => {
      publish(
        await restartOnEarlierConversation(
          await routedClient(connection),
          view,
          `earlier-${sessionId}-${view.state.turn}-${Date.now()}`,
        ),
      );
    },
    stop: async () => {
      publish(await (await routedClient(connection)).stop(sessionId, 'stopped from the sessions bar'));
    },
    resume: async () => {
      publish(await (await routedClient(connection)).resume(sessionId));
    },
    renderRename: host => (
      <RenameForm
        host={host}
        rename={async patch => {
          const renamed = await (
            await routedClient(connection)
          ).rename(sessionId, patch.name, patch.teammate, patch.clearParent);
          publish(renamed);
          return renamed;
        }}
        view={view}
      />
    ),
    renderFork: host => (
      <ForkForm
        fork={async teammate =>
          await forkThroughLatest(await routedClient(connection), view, teammate, `fork-${sessionId}-${Date.now()}`)
        }
        host={host}
        onForked={outcome => onNavigate(daemonSessionPath(daemonId, outcome.session.id))}
        view={view}
      />
    ),
  };
  const sections = sessionActionSections(
    [
      ...CORE_SESSION_ACTIONS,
      ...rowContributions,
      ...warden,
      ...learning.contributions,
      ...hypermedia.contributions,
      ...pack.contributions,
      ...agenda.contributions,
    ],
    context,
  );

  return (
    <>
      {open ? (
        <ContextActionsMenu
          anchor={anchor}
          name={name}
          onClose={onClose}
          onFailure={(sentence, _detail, reason) => {
            if (!restartRefusal.capture(reason)) setNotice(sentence);
          }}
          onNotice={setNotice}
          sections={sections}
          touch={touch}
        />
      ) : null}
      {learning.host}
      {hypermedia.host}
      {pack.host}
      {agenda.host}
      <ActionToast notice={notice} onDismiss={dismissNotice} />
      {restartRefusal.panel}
      {convert.sheet}
      <MigrateSheet
        accountPicker={store.accountPicker}
        canMutate
        connection={connection}
        onClose={() => setMigrateOpen(false)}
        onMigrated={(_daemon, _scope, migrated) => publish(migrated)}
        open={migrateOpen}
        scope={daemonSessionScope(connection, sessionId)}
        usage={store.usage}
        view={view}
      />
    </>
  );
}
