/**
 * The actions every ferret has, as registry contributions. The panel supplies what each one DOES — the daemon calls and
 * the forms — through {@link CoreActionContext}; this file decides only which rows exist for this ferret right now,
 * where they sit and what they say.
 *
 * NOT HERE, ON PURPOSE:
 *   - Interrupt a turn: the turn is Conversation's, and so is its button (`turn.interrupt`).
 *   - Add MCP server, Compact at…, the context menu: their owners' (MCP, Conversation) forms and panels.
 *   - Passive learning, Scan this ferret, Ask the Warden: their features contribute them through the same
 *     {@link FerretActionContribution} these use.
 *   - Move to another worktree: the daemon has no route that moves a live ferret's folder, and a row whose form can
 *     only fail is worse than no row.
 */

import {
  ArrowLeftRight,
  Copy,
  History,
  KeyRound,
  Pencil,
  Pin,
  PinOff,
  Play,
  RotateCw,
  Server,
  Square,
} from 'lucide-react';
import type { ReactNode } from 'react';
import type { FerretSummary, HarnessKey } from '../../../contract/index.ts';
import type { FerretActionContribution, FerretActionFormHost } from './registry.ts';
import { reviveOffer } from './revive-offer.ts';

export interface CoreActionContext {
  readonly ferret: FerretSummary;
  /** The ferret's display name, for the words. */
  readonly name: string;
  /** This connection may change the ferret. Without it only Copy ferret id is offered. */
  readonly canControl: boolean;
  readonly copyId: () => void;
  /** Opens the move page: "Move to another login…". */
  readonly openMove: () => void;
  /**
   * Opens "Move to Codex… / Move to Claude…". Absent where this host cannot offer it, or when the machine has no
   * account of the other harness to move onto; the menu then has no such row.
   */
  readonly openConvert?: () => void;
  readonly restart: () => Promise<void>;
  /**
   * Restart on the conversation an earlier Restart left behind. Absent where a host offers no repair; the menu then
   * has no such row.
   */
  readonly restartOnEarlierConversation?: () => Promise<void>;
  /** Pins or unpins the ferret to the top of the sidebar. Absent where a host cannot reach the route. */
  readonly setPinned?: (pinned: boolean) => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly resume: () => Promise<void>;
  readonly renderRename: (host: FerretActionFormHost) => ReactNode;
}

/** The ids other surfaces open by. */
export const FERRET_ACTION_IDS = {
  rename: 'rename',
  copyId: 'copy-id',
  pin: 'pin',
  move: 'move-login',
  convert: 'move-harness',
  machine: 'move-machine',
  restart: 'restart',
  earlierConversation: 'earlier-conversation',
  resume: 'resume',
  stop: 'stop',
} as const;

const HARNESS_SHORT: Readonly<Record<HarnessKey, string>> = { 'claude-code': 'Claude', codex: 'Codex' };
const otherHarness = (harness: HarnessKey): HarnessKey => (harness === 'codex' ? 'claude-code' : 'codex');

const over = (ferret: FerretSummary): boolean => ferret.state === 'stopped';

export const CORE_FERRET_ACTIONS: readonly FerretActionContribution<CoreActionContext>[] = [
  {
    group: 'ferret',
    order: 7,
    build: context => {
      const { setPinned } = context;
      if (!context.canControl || setPinned === undefined) return null;
      const pinned = context.ferret.pinnedAt !== undefined;
      return {
        kind: 'run',
        id: FERRET_ACTION_IDS.pin,
        label: pinned ? 'Unpin' : 'Pin to top',
        icon: pinned ? PinOff : Pin,
        run: () => setPinned(!pinned),
      };
    },
  },
  {
    group: 'ferret',
    order: 10,
    build: context =>
      context.canControl
        ? {
            kind: 'form',
            id: FERRET_ACTION_IDS.rename,
            label: 'Rename…',
            title: `Rename ${context.name}`,
            icon: Pencil,
            render: context.renderRename,
          }
        : null,
  },
  {
    group: 'ferret',
    order: 30,
    build: context => ({
      kind: 'run',
      id: FERRET_ACTION_IDS.copyId,
      label: 'Copy ferret id',
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
            id: FERRET_ACTION_IDS.move,
            label: 'Move to another login…',
            icon: KeyRound,
            ...(context.ferret.runtime === undefined ? {} : { detail: context.ferret.runtime }),
            run: context.openMove,
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
            id: FERRET_ACTION_IDS.convert,
            label: `Move to ${HARNESS_SHORT[otherHarness(context.ferret.harness)]}…`,
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
            id: FERRET_ACTION_IDS.machine,
            label: 'Move to another machine',
            icon: Server,
            unavailable: 'later',
            run: () => undefined,
          }
        : null,
  },
  {
    group: 'danger',
    order: 10,
    build: context =>
      context.canControl && !over(context.ferret)
        ? {
            kind: 'confirm',
            id: FERRET_ACTION_IDS.restart,
            label: 'Restart CLI',
            icon: RotateCw,
            question: `Restart ${context.name}’s CLI?`,
            consequence: 'It relaunches on the same login and resumes the conversation.',
            confirmLabel: 'Restart',
            run: context.restart,
          }
        : null,
  },
  {
    group: 'danger',
    order: 15,
    build: context =>
      context.canControl && !over(context.ferret) && context.restartOnEarlierConversation !== undefined
        ? {
            kind: 'confirm',
            id: FERRET_ACTION_IDS.earlierConversation,
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
      reviveOffer(context.ferret, context.canControl).offered
        ? { kind: 'run', id: FERRET_ACTION_IDS.resume, label: 'Resume ferret', icon: Play, run: context.resume }
        : null,
  },
  {
    group: 'danger',
    order: 30,
    build: context =>
      context.canControl && !over(context.ferret)
        ? {
            kind: 'confirm',
            id: FERRET_ACTION_IDS.stop,
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
