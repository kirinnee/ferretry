/**
 * THE SESSION'S ONE BAR — the agent's name, where it lives, how it is doing, and what you can do to it.
 *
 * The approved session-view redesign: the page used to spend two rows of chrome before the
 * conversation started — a header with a task title, a runtime eyebrow and a session id, then a second
 * toolbar of lifecycle buttons, pane openers, an Attention button and a live-feed chip. ONE bar now
 * carries:
 *
 *   - the ferret's name (the callsign) and the project it is working in — nothing else identifies it;
 *   - its status as a dot and a word, which is also where "needs you" and a dead live feed show up;
 *   - Interrupt and Stop/Start, beside the name rather than in a row below it;
 *   - ⓘ Info, which is for LOOKING: a resizable right panel on a desktop, a bottom sheet on a phone;
 *   - Actions ▾, which is for DOING: one grouped dropdown on every width.
 *
 * That is the header's one rule, LOOK vs DO. The old ⋯ menu and the panel-toggle icon are gone: what
 * they held is now either a fact in Info or an action in Actions.
 *
 * On a phone the bar is ☰ (the sessions drawer), the name, the status dot, the primary action, ⓘ and ▾ —
 * and nothing else: the switch marks (Learning, Hypermedia, Pack) live in Info there, and a dropped live
 * feed is one small icon, not a word and a link.
 *
 * PRESENTATIONAL ONLY. The page owns every action and every piece of state; this file draws what it is
 * handed, so a test can mount it with plain values and the page cannot end up with two owners of the
 * same session mutation.
 */

import { displaySystemCallsign, type SessionView } from '@ferretry/protocol';
import { Info, Menu } from 'lucide-react';
import type { ReactNode } from 'react';
import { agendaOn, hypermediaOn, packOn } from '../features/session-info/info-model.ts';
import { SwitchMarks, type SwitchMarksProps } from '../features/session-info/switch-marks.tsx';
import { displayCallsign } from '../lib/callsign.ts';
import { harnessWord } from '../lib/harness-dialogs.ts';
import { permissionPhrase } from '../lib/permission-requests.ts';
import type { SessionTurn } from '../lib/session-activity.ts';
import { sessionStatusLabel } from '../lib/session-screens.ts';
import { StatusMark } from '../shell/status-mark.tsx';
import { UnreadBadge } from '../shell/unread-badge.tsx';

/**
 * The name a person calls this session by: its callsign, else whatever the session was labelled,
 * else its id. The callsign leads because it is how teammates are referred to everywhere else.
 */
export const sessionDisplayName = (session: SessionView): string => {
  const { config } = session;
  return displaySystemCallsign(displayCallsign(config.teammate) || config.label || config.name || config.id);
};

/** The status word for each turn: the person's words, not the daemon's. */
const TURN_WORD: Readonly<Record<SessionTurn, string>> = {
  working: 'working',
  'your-turn': 'your turn',
  'needs-input': 'needs input',
};

export interface SessionTopBarProps {
  readonly session: SessionView;
  /** The project this session's folder belongs to, or null when it cannot be named. */
  readonly project: string | null;
  /** Phone layout: the project and the status word give their room to the name. */
  readonly compact: boolean;
  /** The primary lifecycle actions, rendered by the page that owns them. */
  readonly actions: ReactNode;
  /**
   * How many Attention items are open on this ferret. A small accent count beside the name when there are
   * any, nothing when there are none — the pinned block above the composer is the item itself.
   */
  readonly attentionOpen?: number;
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
  /** Actions ▾, rendered by the page that owns every action. */
  readonly menu?: ReactNode;
  /** The far-right control after Actions ▾: the phone's theme quick switch. */
  readonly trailing?: ReactNode;
  /** Phone only: opens the sessions drawer. */
  readonly onOpenSessions?: () => void;
  /** The ferret that started this one, as a link to it. Absent for a ferret a person started. */
  readonly startedBy?: { readonly name: string; readonly onOpen: () => void };
  /** The ACTIVE sub-ferrets this ferret started, as the indicator that lists them (`sub-ferrets.tsx`). Never drawn on a phone. */
  readonly subFerrets?: ReactNode;
  /**
   * The ferret's switch marks beside its name, with the switches' latest answers and, for a reader who may
   * control it, the tap that switches one. Absent: read from the session's own record, marks only.
   */
  readonly switches?: SwitchMarksProps;
}

export function SessionTopBar({
  session,
  project,
  compact,
  actions,
  attentionOpen = 0,
  status,
  turn = null,
  infoOpen = false,
  onToggleInfo,
  menu,
  trailing,
  onOpenSessions,
  startedBy,
  subFerrets,
  switches,
}: SessionTopBarProps) {
  const name = sessionDisplayName(session);
  const task = session.config.label ?? session.config.name;
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
      <div className="fy-session-bar__who" title={task === undefined ? name : `${name} — ${task}`}>
        <h1 className="fy-session-bar__name">{name}</h1>
        {attentionOpen > 0 ? <UnreadBadge className="fy-session-bar__attention" count={attentionOpen} /> : null}
        {compact ? null : (
          <SwitchMarks
            {...{
              agenda: agendaOn(session),
              ...(switches ?? { learning: false, hypermedia: hypermediaOn(session), pack: packOn(session) }),
            }}
          />
        )}
        {project === null || compact ? null : <span className="fy-session-bar__project">{project}</span>}
        {startedBy === undefined || compact ? null : (
          <button
            className="fy-session-bar__started-by"
            data-session-started-by=""
            onClick={startedBy.onOpen}
            title={`Started by ${startedBy.name}`}
            type="button"
          >
            Started by {startedBy.name}
          </button>
        )}
        {compact ? null : subFerrets}
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
      <div className="fy-session-bar__actions" data-session-actions="">
        {actions}
      </div>
      {onToggleInfo === undefined ? null : (
        <button
          aria-label={compact ? 'Info' : undefined}
          aria-pressed={infoOpen}
          className={compact ? 'fy-session-bar__icon' : 'fy-session-bar__info kt-btn kt-btn--sm'}
          data-session-info-toggle=""
          onClick={onToggleInfo}
          type="button"
        >
          <Info aria-hidden="true" size={compact ? 18 : 14} />
          {compact ? null : <span>Info</span>}
        </button>
      )}
      {menu}
      {trailing}
    </header>
  );
}
