/**
 * THE SESSION'S ONE BAR — the agent's name, how it is doing, and what you can do to it. Nothing else.
 *
 * The owner (2026-10-30): "top bar is too crowded". The bar had grown to the name, an unread badge, a
 * refresh mark, four capability icons, a sub-ferrets pill, a task chip, an Agenda toggle, Interrupt, Stop,
 * Info, Actions and a theme switch. It now carries only:
 *
 *   - the ferret's task title (and its callsign when that differs) — what it is;
 *   - its status as a dot and a word, which is also where "needs you" and a dead live feed show up;
 *   - Interrupt and Stop/Start, beside the name;
 *   - ⓘ, an icon with no word, which opens Info (a right panel on a desktop, a bottom sheet on a phone);
 *   - Actions ▾, the ONE overflow: Theme and every action sit in it.
 *
 * Everything that left is in Info › Overview, in its "About this ferret" block: its sub-ferrets, its card,
 * its capabilities (the switch marks), Restart and its agenda. Nothing was removed, only moved.
 *
 * ON A PHONE THE BAR IS ONE COMPACT ROW: ☰ (the sessions drawer), the title (cut with an ellipsis; the whole
 * title is Info › Overview's Task row), ONE status dot, ⓘ and ▾ — and nothing else: the page puts Interrupt
 * in ▾, and this bar draws none of `actions`.
 *
 * PRESENTATIONAL ONLY. The page owns every action and every piece of state; this file draws what it is
 * handed, so a test can mount it with plain values and the page cannot end up with two owners of the
 * same session mutation.
 */

import { displaySystemCallsign, type SessionView } from '@ferretry/protocol';
import { Info, Menu } from 'lucide-react';
import type { ReactNode } from 'react';
import { displayCallsign } from '../lib/callsign.ts';
import { harnessWord } from '../lib/harness-dialogs.ts';
import { permissionPhrase } from '../lib/permission-requests.ts';
import type { SessionTurn } from '../lib/session-activity.ts';
import { sessionStatusLabel } from '../lib/session-screens.ts';
import { sessionTask } from '../shell/session-title.ts';
import { StatusMark } from '../shell/status-mark.tsx';

/**
 * WHO is working on this session: its callsign, else the name it was given, else its id. This is the
 * speaker in the transcript and the secondary line of a header — never the session's title (see
 * `sessionTitle`).
 */
export const sessionDisplayName = (session: SessionView): string => {
  const { config } = session;
  return displaySystemCallsign(displayCallsign(config.teammate) || config.name || config.id);
};

/**
 * WHAT this session is for: the task it was named, never the callsign. A name with a leading `[Teammate]`
 * prefix is shown without it — the callsign is already said beside the title. Falls back to the callsign
 * only when the session has no task (the daemon's `interactive` placeholder is none).
 */
export const sessionTitle = (session: SessionView): string =>
  sessionTask(session.config.name) || sessionDisplayName(session);

/** The status word for each turn: the person's words, not the daemon's. */
const TURN_WORD: Readonly<Record<SessionTurn, string>> = {
  working: 'working',
  'your-turn': 'your turn',
  'needs-input': 'needs input',
};

export interface SessionTopBarProps {
  readonly session: SessionView;
  /** Phone layout: the callsign and the status word give their room to the name. */
  readonly compact: boolean;
  /** The primary lifecycle actions, rendered by the page that owns them. Not drawn on a phone: they are in ▾. */
  readonly actions: ReactNode;
  /** Status additions after the status word: "needs you", a dead live feed. */
  readonly status?: ReactNode;
  /**
   * Whose turn it is (`lib/session-activity.ts`), or `null` for a session that is not live. The
   * daemon's `running` only says the terminal is live, so without this an idle session read as
   * Running.
   */
  readonly turn?: SessionTurn | null;
  /** Whether Info is open. */
  readonly infoOpen?: boolean;
  /** The ⓘ that opens or closes Info. Absent: this host shows no Info, and draws no ⓘ. */
  readonly onToggleInfo?: () => void;
  /** Actions ▾, the one overflow, rendered by the page that owns every action. */
  readonly menu?: ReactNode;
  /** Phone only: opens the sessions drawer. */
  readonly onOpenSessions?: () => void;
}

export function SessionTopBar({
  session,
  compact,
  actions,
  status,
  turn = null,
  infoOpen = false,
  onToggleInfo,
  menu,
  onOpenSessions,
}: SessionTopBarProps) {
  const name = sessionDisplayName(session);
  const title = sessionTitle(session);
  // What a needs-input session is parked on: the one thing it is waiting for. A permission prompt is said
  // as the request itself and a harness dialog as its own title — what the person is being asked to decide.
  const permission = turn === 'needs-input' ? session.state.permissionRequest : undefined;
  const dialog = turn === 'needs-input' && permission === undefined ? session.state.harnessDialog : undefined;
  const approval =
    permission !== undefined
      ? `Waiting for approval: ${permissionPhrase(permission)}`
      : dialog === undefined
        ? undefined
        : `Waiting on ${harnessWord(dialog.harness)}: ${dialog.title}`;
  const blockedBy = approval ?? (turn === 'needs-input' ? session.state.turnPrompt : undefined);

  return (
    <header className="fy-session-bar" data-compact={compact ? '' : undefined} data-session-bar="">
      {onOpenSessions === undefined ? null : (
        <button
          aria-label="Open sessions"
          className="fy-session-bar__icon"
          data-session-bar-sessions=""
          onClick={onOpenSessions}
          type="button"
        >
          <Menu aria-hidden="true" size={18} />
        </button>
      )}
      <div className="fy-session-bar__who" title={title === name ? name : `${title} — ${name}`}>
        <h1 className="fy-session-bar__name">{title}</h1>
        {title === name || compact ? null : (
          <span className="fy-session-bar__callsign" data-session-callsign="">
            {name}
          </span>
        )}
        <span
          className="fy-session-bar__status"
          data-session-activity={turn ?? undefined}
          data-session-status={session.state.status}
          title={approval ?? (blockedBy === undefined ? undefined : `On screen: ${blockedBy}`)}
        >
          <StatusMark ready={turn === 'your-turn' && session.state.turnState === undefined} view={session} />
          <span className={compact ? 'sr-only' : 'fy-session-bar__word'}>
            {turn === null ? sessionStatusLabel(session.state.status) : TURN_WORD[turn]}
          </span>
          {blockedBy === undefined ? null : (
            <span className={compact ? 'sr-only' : 'fy-session-bar__blocked'} data-session-blocked-by="">
              <span className="sr-only">{approval === undefined ? ', on screen: ' : ', '}</span>
              {blockedBy}
            </span>
          )}
          {status}
        </span>
      </div>
      {compact ? null : (
        <div className="fy-session-bar__actions" data-session-actions="">
          {actions}
        </div>
      )}
      {onToggleInfo === undefined ? null : (
        <button
          aria-label="Info"
          aria-pressed={infoOpen}
          className="fy-session-bar__info fy-session-bar__icon"
          data-session-info-toggle=""
          onClick={onToggleInfo}
          title="Info"
          type="button"
        >
          <Info aria-hidden="true" size={18} />
        </button>
      )}
      {menu}
    </header>
  );
}
