/**
 * ONE reference surface per session, shared by every Markdown reader in it.
 *
 * The reference standard is only one standard if the transcript, a notice, task
 * prose, Attention prose, a file preview and the composer's preview all read the
 * same grammar, ask the same resolvers, and open the same destinations. Passing
 * six props down six different trees would guarantee they drift, so the surface
 * is assembled ONCE where the daemon connection and the session live, and every
 * reader takes it from context.
 *
 * PROOF IS STILL PER-KIND, AND ABSENCE IS HONEST. A resolver is supplied only
 * when this session can actually prove that kind: no fleet slice means no
 * `:agent` link, `sessions === null` (not yet read) is NOT an empty fleet, and a
 * kind with no opener renders as prose rather than as a link that goes nowhere.
 * A surface with nothing wired is exactly the default value of this context,
 * which is why the default is an empty object and not a set of stubs.
 *
 * MULTI-DAEMON. Everything here is built from one `(daemonId, sessionId)` scope
 * and one `DaemonConnection` that must own it. The agent resolver stamps its
 * daemon onto every answer (`agent-references.ts`), the filesystem read is bound
 * to the same connection, and every click destination is a side-pane tab in that
 * scope — so a reference in one daemon's transcript cannot open another daemon's
 * file, terminal or session.
 */

import type { AgendaId, BrowserStatus, SessionView, TerminalListView } from '@ferretry/protocol';
import { createContext, type ReactNode, useContext } from 'react';

import { createAgentReferenceResolver } from '../lib/agent-references.ts';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../lib/daemon-scope.ts';
import { daemonBoardCardPath } from '../lib/pages/routes.ts';
import type { ResolvedSurfaceReference } from '../lib/references.ts';
import type { DaemonFetch } from '../lib/runtime-models.ts';
import { resolveCardReference } from '../lib/session-cards.ts';
import { createSurfaceReferenceResolver, terminalIdForSurfaceKey } from '../lib/surface-references.ts';
import { createTaskReferenceResolver } from '../lib/task-reference-context.tsx';
import {
  openSidePaneFileTab,
  openSidePaneTab,
  openSidePaneTerminalTab,
  type SidePaneFileSelection,
} from '../shell/side-pane-tab-model.ts';
import { resolveFsFilePaths } from './files-api.ts';
import { readWorkspaceMedia } from './fy-render-workspace-media.ts';
import type { MarkdownProps } from './markdown.tsx';

/** Everything a Markdown reader needs to prove and to open a reference. */
export type ReferenceSurface = Omit<MarkdownProps, 'text' | 'className' | 'copyable'>;

/** Nothing proved and nothing openable: reference-shaped text stays prose. */
const NO_SURFACE: ReferenceSurface = {};

const ReferenceSurfaceContext = createContext<ReferenceSurface>(NO_SURFACE);

/** The surface this reader sits in, or the honest empty one outside a session. */
export const useReferenceSurface = (): ReferenceSurface => useContext(ReferenceSurfaceContext);

export function ReferenceSurfaceProvider({
  surface,
  children,
}: {
  readonly surface: ReferenceSurface;
  readonly children: ReactNode;
}) {
  return <ReferenceSurfaceContext.Provider value={surface}>{children}</ReferenceSurfaceContext.Provider>;
}

export interface SessionReferenceSurfaceOptions {
  readonly connection: DaemonConnection;
  /**
   * The fetch the `@file` proof reads listings through — the carrier router, so a session on a
   * daemon only the relay reaches still proves its file references.
   */
  readonly fetcher: DaemonFetch;
  readonly scope: DaemonSessionScope;
  /** The session's working directory; without it no absolute path can resolve. */
  readonly cwd?: string;
  /**
   * This daemon's own fleet slice. `undefined` means "not read yet", which is
   * why it is not defaulted to an empty array: an unread fleet must not be
   * reported as a fleet with nobody in it.
   */
  readonly sessions?: readonly SessionView[];
  /** This ferret's slice of the board (its cards, old ids included), when the host already holds it. */
  readonly tasks?: readonly { readonly id: string; readonly legacyId?: string | null }[];
  /**
   * Every card id on this machine, whatever its project, lane or state, when the host already holds it. A
   * reference to any of them opens its card; `tasks` still decides the old ids and the `&` menu.
   */
  readonly taskIds?: ReadonlySet<string>;
  /**
   * This session's Agenda LEDGER — open and resolved ids — when the host already holds it. An
   * answered item is still on the record, so its `!A3` stays a link.
   */
  readonly agendaIds?: readonly AgendaId[];
  /** Opens the session's Agenda panel at one proved item, open or resolved. */
  readonly onAgendaOpen?: (id: AgendaId, opener?: HTMLElement | null) => void;
  /** This session's skills catalog names, when the host already holds it. */
  readonly skills?: readonly string[];
  /**
   * This session's terminal listing, for proving `%terminal:…` surfaces. A null
   * or absent listing proves NOTHING in either direction — it is neither an open
   * surface nor a closed one — which is what `createSurfaceReferenceResolver`
   * already encodes.
   */
  readonly terminals?: TerminalListView | null;
  /**
   * This session's browser status, for proving `%browser:…` pages. Like the terminal listing, a null or
   * absent status — or one in a state whose page list is not complete — proves nothing either way.
   */
  readonly browser?: BrowserStatus | null;
  /**
   * In-app navigation, for the one reference kind that IS a route. Without it an
   * agent reference has no destination, so it stays prose rather than becoming a
   * link whose click is swallowed.
   */
  readonly onNavigate?: (to: string) => void;
  /** False when this machine has no board route (an older daemon): `&F12` then keeps the Tasks destination. */
  readonly cardRoute?: boolean;
  /**
   * Where the session page shows what a reference opens — the split workspace's tabs and the context
   * rail. Each one absent falls back to this scope's side pane, which is what a host with no
   * workspace (a test, a harness card) still has. The CLICK is the same either way: Markdown calls
   * this surface, and only the destination differs.
   */
  readonly destinations?: ReferenceDestinations;
}

/** The session page's own places for what a proved reference opens. */
interface ReferenceDestinations {
  readonly openFile?: (path: string, selection?: SidePaneFileSelection) => void;
  readonly openSurface?: (reference: ResolvedSurfaceReference) => void;
  readonly openTasks?: () => void;
  readonly openSkills?: () => void;
}

const fileSelection = (line?: number, endLine?: number): SidePaneFileSelection | undefined => {
  if (line === undefined) return undefined;
  return endLine === undefined ? { line } : { line, endLine };
};

/**
 * Assemble the surface one session workspace can honestly offer.
 *
 * Every click lands in the side pane of THIS scope, which is where the reader
 * already reads files, terminals, tasks, Attention and skills — so a reference
 * opens the same surface the reader would have opened by hand, rather than a
 * second half-built detail view.
 */
export function sessionReferenceSurface(options: SessionReferenceSurfaceOptions): ReferenceSurface {
  const {
    connection,
    fetcher,
    scope,
    cwd,
    sessions,
    tasks,
    taskIds,
    agendaIds,
    onAgendaOpen,
    skills,
    terminals,
    browser,
    onNavigate,
    cardRoute = true,
    destinations = {},
  } = options;
  const agenda = agendaIds === undefined ? undefined : new Set<string>(agendaIds);
  // EXACT names, never case-folded. The catalog accepts any nonempty trimmed
  // name, while the reference grammar accepts lowercase ones only — so folding a
  // catalog entry `Floop` into `floop` would prove `/floop`, a DIFFERENT and
  // valid identity, from a catalog entry that has no valid reference at all.
  // Add to chat already refuses `/Floop`, so the folded set made the transcript
  // and the action disagree about what this session can address. The candidate
  // arriving here was parsed by that grammar and is therefore already lowercase,
  // which is what makes exact membership the correct and complete test.
  const skillNames = skills === undefined ? undefined : new Set(skills);
  return {
    ...(sessions === undefined
      ? {}
      : { agentReferenceResolver: createAgentReferenceResolver(scope.daemonId, sessions) }),
    ...(tasks === undefined && taskIds === undefined
      ? {}
      : { taskReferenceResolver: createTaskReferenceResolver(tasks, taskIds) }),
    ...(agenda === undefined ? {} : { agendaReferenceResolver: (id: AgendaId) => agenda.has(id) }),
    ...(skillNames === undefined ? {} : { skillReferenceResolver: (name: string) => skillNames.has(name) }),
    // Always supplied, because this resolver is the only thing that can say
    // "closed" as opposed to "unknown", and it answers nothing when it has no
    // listing to answer from.
    surfaceReferenceResolver: createSurfaceReferenceResolver(scope, terminals, browser),
    resolveFilePaths: async (candidates, signal) =>
      await resolveFsFilePaths(connection, scope, candidates, cwd, fetcher, signal),
    // A `fy-render` media block's `src: @path`, read through the same route and the same grants an
    // `@file` click uses. The block receives this one function and never the connection behind it.
    readWorkspaceMedia: async (path, signal, folder) =>
      await readWorkspaceMedia(connection, scope, path, cwd, fetcher, signal, folder),
    onCodeReferenceOpen: reference => {
      const selection = fileSelection(reference.line, reference.endLine);
      if (destinations.openFile !== undefined) destinations.openFile(reference.path, selection);
      else openSidePaneFileTab(scope, reference.path, selection);
    },
    // ONE click behaviour: `&F412` opens the card detail on THIS machine's board, which a link and Back both
    // reach, in a chat as anywhere. Only a host with no card route (an older daemon, or no router) falls
    // back to its own Tasks destination, when it has one.
    onTaskOpen: written => {
      const id = tasks === undefined ? written : (resolveCardReference(tasks, written) ?? written);
      if (cardRoute && onNavigate !== undefined) onNavigate(daemonBoardCardPath(scope.daemonId, id.toUpperCase()));
      else destinations.openTasks?.();
    },
    // Attention is deliberately NOT a side-pane tab (handover #35). A proved
    // id opens the Agenda panel at the top of the conversation, at that item;
    // when either the ledger or opener is absent Markdown still leaves `!A3` as
    // prose rather than manufacturing a dead link.
    ...(agenda === undefined || onAgendaOpen === undefined ? {} : { onAgendaOpen }),
    onSkillOpen: destinations.openSkills ?? (() => openSidePaneTab(scope, 'skills')),
    ...(onNavigate === undefined ? {} : { onNavigate }),
    onSurfaceOpen: reference => {
      if (destinations.openSurface !== undefined) {
        destinations.openSurface(reference);
        return;
      }
      // Only terminals have a side-pane tab to focus: a page is opened as a workspace tab, which a host
      // without a workspace does not have, so a proved `%browser:…` opens nothing here rather than a
      // guessed destination.
      if (reference.surface === 'terminal')
        openSidePaneTerminalTab(scope, terminalIdForSurfaceKey(terminals, reference.key) ?? reference.key);
    },
  };
}
