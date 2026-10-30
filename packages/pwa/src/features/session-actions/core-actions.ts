/**
 * The actions every ferret has, as registry contributions. The page supplies what each one DOES — the
 * daemon calls and the forms — through {@link CoreActionContext}; this file decides only which rows
 * exist for this ferret right now, where they sit and what they say.
 *
 * NOT HERE, ON PURPOSE:
 *   - Move to another worktree: the daemon has no route that moves a live session's folder, and a row
 *     whose form can only fail is worse than no row. It returns when that route exists.
 *   - Passive learning, Scan this ferret, Ask the Warden: their features contribute them (they are
 *     the plan's later PRs), through the same `SessionActionContribution` these use.
 */

import type { SessionView } from '@ferretry/protocol';
import {
  ArrowLeftRight,
  Copy,
  GitFork,
  History,
  KeyRound,
  Pencil,
  Play,
  Plug,
  RotateCw,
  Server,
  Square,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { TERMINAL_STATUSES } from '../../shell/status-mark.tsx';
import { isOutdated, outdatedSectionWords } from '../restart-outdated/outdated-model.ts';
import { HARNESS_SHORT, otherHarness } from '../fleet/credentials/credentials-model.ts';
import type { SessionActionContribution, SessionActionFormHost } from './registry.ts';

export interface CoreActionContext {
  readonly view: SessionView;
  /** The ferret's display name, for the words. */
  readonly name: string;
  /** This connection may change the ferret. Without it only Copy session id is offered. */
  readonly canControl: boolean;
  readonly copyId: () => void;
  readonly openMigrate: () => void;
  /**
   * Opens "Move to Codex… / Move to Claude…". Absent where this host cannot offer it, or when the machine
   * has no account of the other harness to move onto; the menu then has no such row.
   */
  readonly openConvert?: () => void;
  readonly restart: () => Promise<void>;
  /**
   * Restart on the conversation an earlier Restart left behind. Absent where a host offers no repair;
   * the menu then has no such row.
   */
  readonly restartOnEarlierConversation?: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly resume: () => Promise<void>;
  readonly renderRename: (host: SessionActionFormHost) => ReactNode;
  readonly renderFork: (host: SessionActionFormHost) => ReactNode;
  /** Absent when this host cannot reach the session MCP routes. */
  readonly renderAddMcp?: (host: SessionActionFormHost) => ReactNode;
}

/** The ids other surfaces open by: Info's rename pencil, Info › Folder › MCP's "Add…". */
export const SESSION_ACTION_IDS = {
  rename: 'rename',
  fork: 'fork',
  copyId: 'copy-id',
  migrate: 'move-login',
  convert: 'move-harness',
  machine: 'move-machine',
  addMcp: 'add-mcp',
  restart: 'restart',
  earlierConversation: 'earlier-conversation',
  resume: 'resume',
  stop: 'stop',
} as const;

const terminal = (view: SessionView): boolean => TERMINAL_STATUSES.has(view.state.status);
const killFailed = (view: SessionView): boolean => view.state.status === 'kill_failed';

export const CORE_SESSION_ACTIONS: readonly SessionActionContribution<CoreActionContext>[] = [
  {
    group: 'session',
    order: 10,
    build: context =>
      context.canControl
        ? {
            kind: 'form',
            id: SESSION_ACTION_IDS.rename,
            label: 'Rename…',
            title: `Rename ${context.name}`,
            icon: Pencil,
            render: context.renderRename,
          }
        : null,
  },
  {
    group: 'session',
    order: 20,
    build: context =>
      context.canControl
        ? {
            kind: 'form',
            id: SESSION_ACTION_IDS.fork,
            label: 'Fork into a new ferret…',
            title: `Fork ${context.name} into a new ferret`,
            icon: GitFork,
            render: context.renderFork,
          }
        : null,
  },
  {
    group: 'session',
    order: 30,
    build: context => ({
      kind: 'run',
      id: SESSION_ACTION_IDS.copyId,
      label: 'Copy session id',
      icon: Copy,
      run: context.copyId,
    }),
  },
  {
    group: 'move',
    order: 10,
    build: context =>
      context.canControl
        ? {
            kind: 'run',
            id: SESSION_ACTION_IDS.migrate,
            label: 'Move to another login…',
            icon: KeyRound,
            detail: context.view.config.agent,
            run: context.openMigrate,
          }
        : null,
  },
  {
    group: 'move',
    order: 20,
    build: context =>
      context.canControl && context.openConvert !== undefined
        ? {
            kind: 'run',
            id: SESSION_ACTION_IDS.convert,
            label: `Move to ${HARNESS_SHORT[otherHarness(context.view.config.harness)]}…`,
            icon: ArrowLeftRight,
            run: context.openConvert,
          }
        : null,
  },
  {
    group: 'move',
    order: 30,
    build: context =>
      context.canControl
        ? {
            kind: 'run',
            id: SESSION_ACTION_IDS.machine,
            label: 'Move to another machine',
            icon: Server,
            unavailable: 'later',
            run: () => undefined,
          }
        : null,
  },
  {
    group: 'tools',
    order: 10,
    build: context =>
      context.canControl && context.renderAddMcp !== undefined
        ? {
            kind: 'form',
            id: SESSION_ACTION_IDS.addMcp,
            label: 'Add MCP server…',
            title: 'Add MCP server',
            icon: Plug,
            render: context.renderAddMcp,
          }
        : null,
  },
  {
    group: 'danger',
    order: 10,
    build: context =>
      context.canControl && !terminal(context.view)
        ? {
            kind: 'confirm',
            id: SESSION_ACTION_IDS.restart,
            label: 'Restart CLI',
            icon: RotateCw,
            // An outdated ferret says so HERE on a phone, whose bar has no room for the mark: this is its remedy.
            ...(isOutdated(context.view) ? { detail: 'Outdated' } : {}),
            question: `Restart ${context.name}’s CLI?`,
            consequence: isOutdated(context.view)
              ? `It relaunches on the same login, resumes the conversation and loads the new instructions${
                  outdatedSectionWords(context.view) === '' ? '' : ` (${outdatedSectionWords(context.view)})`
                }.`
              : 'It relaunches on the same login and resumes the conversation.',
            confirmLabel: 'Restart',
            run: context.restart,
          }
        : null,
  },
  {
    group: 'danger',
    order: 15,
    build: context =>
      context.canControl && !terminal(context.view) && context.restartOnEarlierConversation !== undefined
        ? {
            kind: 'confirm',
            id: SESSION_ACTION_IDS.earlierConversation,
            label: 'Go back to the earlier conversation…',
            icon: History,
            question: `Restart ${context.name} on its earlier conversation?`,
            consequence:
              'For a ferret that came back from a Restart with no memory: it relaunches on the conversation it had before.',
            confirmLabel: 'Go back',
            run: context.restartOnEarlierConversation,
          }
        : null,
  },
  {
    group: 'danger',
    order: 20,
    build: context =>
      context.canControl && terminal(context.view) && !killFailed(context.view)
        ? { kind: 'run', id: SESSION_ACTION_IDS.resume, label: 'Resume ferret', icon: Play, run: context.resume }
        : null,
  },
  {
    group: 'danger',
    order: 30,
    build: context =>
      context.canControl && (!terminal(context.view) || killFailed(context.view))
        ? {
            kind: 'confirm',
            id: SESSION_ACTION_IDS.stop,
            label: 'Stop ferret…',
            icon: Square,
            danger: true,
            question: `Stop ${context.name}?`,
            consequence: 'The CLI exits; the transcript stays.',
            confirmLabel: 'Stop ferret',
            run: context.stop,
          }
        : null,
  },
];
