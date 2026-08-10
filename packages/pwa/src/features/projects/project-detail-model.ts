import type { ProjectInfo, SessionView } from '@ferretry/protocol';

import { normalizeProjectPath } from '../../lib/fleet-grouping.ts';
import { TERMINAL_STATUSES } from '../../shell/status-mark.tsx';

/**
 * The fleet grouping module owns how daemon-provided paths compare. Detail uses
 * its normalizer rather than growing a second cwd rule in a component.
 */
export const projectSessions = (project: ProjectInfo, sessions: readonly SessionView[]): readonly SessionView[] => {
  const root = normalizeProjectPath(project.path);
  return sessions
    .filter(session => normalizeProjectPath(session.config.cwd) === root)
    .toSorted((left, right) => {
      const leftAt = Date.parse(left.state.lastActivityAt ?? left.config.updatedAt ?? '') || 0;
      const rightAt = Date.parse(right.state.lastActivityAt ?? right.config.updatedAt ?? '') || 0;
      return rightAt - leftAt;
    });
};

/** Active means a session the fleet does not report as terminal. */
export const activeProjectSessions = (sessions: readonly SessionView[]): readonly SessionView[] =>
  sessions.filter(session => !TERMINAL_STATUSES.has(session.state.status));

/** A board has no project key; this is the honest session-derived projection. */
export const projectBoardSessions = (sessions: readonly SessionView[]): readonly SessionView[] =>
  sessions.filter(session => session.config.boardAccess !== 'none');
