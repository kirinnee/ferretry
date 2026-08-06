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

import type { AttentionId, SessionView, TerminalListView } from '@ferretry/protocol';
import { createContext, type ReactNode, useContext } from 'react';

import { createAgentReferenceResolver } from '../lib/agent-references.ts';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../lib/daemon-scope.ts';
import { createSurfaceReferenceResolver } from '../lib/surface-references.ts';
import { createTaskReferenceResolver } from '../lib/task-reference-context.tsx';
import {
  openSidePaneFileTab,
  openSidePaneTab,
  openSidePaneTerminalTab,
  type SidePaneFileSelection,
} from '../shell/side-pane-tab-model.ts';
import { resolveFsFilePaths } from './files-api.ts';
import type { MarkdownProps } from './markdown.tsx';

/** Everything a Markdown reader needs to prove and to open a reference. */
export type ReferenceSurface = Omit<MarkdownProps, 'text' | 'className'>;

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
  readonly scope: DaemonSessionScope;
  /** The session's working directory; without it no absolute path can resolve. */
  readonly cwd?: string;
  /**
   * This daemon's own fleet slice. `undefined` means "not read yet", which is
   * why it is not defaulted to an empty array: an unread fleet must not be
   * reported as a fleet with nobody in it.
   */
  readonly sessions?: readonly SessionView[];
  /** This session's task board, when the host already holds it. */
  readonly tasks?: readonly { readonly id: string }[];
  /** This session's unresolved Attention ledger, when the host already holds it. */
  readonly attentionIds?: readonly AttentionId[];
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
   * In-app navigation, for the one reference kind that IS a route. Without it an
   * agent reference has no destination, so it stays prose rather than becoming a
   * link whose click is swallowed.
   */
  readonly onNavigate?: (to: string) => void;
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
  const { connection, scope, cwd, sessions, tasks, attentionIds, skills, terminals, onNavigate } = options;
  const attention = attentionIds === undefined ? undefined : new Set<string>(attentionIds);
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
    ...(tasks === undefined ? {} : { taskReferenceResolver: createTaskReferenceResolver(tasks) }),
    ...(attention === undefined ? {} : { attentionReferenceResolver: (id: AttentionId) => attention.has(id) }),
    ...(skillNames === undefined ? {} : { skillReferenceResolver: (name: string) => skillNames.has(name) }),
    // Always supplied, because this resolver is the only thing that can say
    // "closed" as opposed to "unknown", and it answers nothing when it has no
    // listing to answer from.
    surfaceReferenceResolver: createSurfaceReferenceResolver(scope, terminals),
    resolveFilePaths: async (candidates, signal) =>
      await resolveFsFilePaths(connection, scope, candidates, cwd, signal),
    onCodeReferenceOpen: reference => {
      openSidePaneFileTab(scope, reference.path, fileSelection(reference.line, reference.endLine));
    },
    onTaskOpen: () => openSidePaneTab(scope, 'tasks'),
    // No `onAttentionOpen`. Attention is deliberately NOT a side-pane tab
    // (handover #35); its home is the focused action modal of #17, which does
    // not exist yet. Omitting the opener makes a proved `!A3` render as text
    // rather than as a link into a surface that is not there — `hasOpener` in
    // markdown.tsx reads the omission, so this is the honest state, not a gap
    // dressed as a dead link.
    onSkillOpen: () => openSidePaneTab(scope, 'skills'),
    ...(onNavigate === undefined ? {} : { onNavigate }),
    onSurfaceOpen: reference => {
      // Only terminals have a pane to focus. A `%browser:…` surface cannot be
      // proved at all on this daemon (there is no worker and no page listing), so
      // this arm is unreachable for one today — and it refuses rather than
      // guessing a destination if that ever changes before the pane does.
      if (reference.surface === 'terminal') openSidePaneTerminalTab(scope, reference.key);
    },
  };
}
