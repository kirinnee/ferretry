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
 *   - ⋯, which holds everything that used to be on screen permanently: runtime, mode and id, Files, the
 *     terminals, moving to another login, this session's analytics, copying the id, and the details.
 *
 * On a phone the bar is ☰ (the sessions drawer), the name, the status dot, the primary action and ⋯.
 *
 * PRESENTATIONAL ONLY. The page owns every action and every piece of state; this file draws what it is
 * handed, so a test can mount it with plain values and the page cannot end up with two owners of the
 * same session mutation.
 */

import type { SessionView } from '@ferretry/protocol';
import { Ellipsis, Menu } from 'lucide-react';
import { type ReactNode, useRef, useState } from 'react';
import { displayCallsign } from '../lib/callsign.ts';
import { sessionStatusLabel } from '../lib/session-screens.ts';
import { ContextMenu, type ContextMenuItem, type MenuAnchor } from '../shell/context-menu.tsx';
import { StatusMark } from '../shell/status-mark.tsx';

/**
 * The name a person calls this session by: its callsign, else whatever the session was labelled,
 * else its id. The callsign leads because it is how teammates are referred to everywhere else.
 */
export const sessionDisplayName = (session: SessionView): string => {
  const { config } = session;
  return displayCallsign(config.teammate) || config.label || config.name || config.id;
};

/** The ⋯ menu's first line: what is running, in which mode, under which id. */
export const sessionRuntimeLine = (session: SessionView): string =>
  [session.config.agent, session.config.mode, session.config.id].filter(part => part !== '').join(' · ');

export interface SessionTopBarProps {
  readonly session: SessionView;
  /** The project this session's folder belongs to, or null when it cannot be named. */
  readonly project: string | null;
  /** Phone layout: the project and the status word give their room to the name. */
  readonly compact: boolean;
  /** The primary lifecycle actions, rendered by the page that owns them. */
  readonly actions: ReactNode;
  /** Status additions after the status word: "needs you", a dead live feed. */
  readonly status?: ReactNode;
  /** Everything else this session offers, in ⋯. */
  readonly menuItems: readonly ContextMenuItem[];
  /** Phone only: opens the sessions drawer. */
  readonly onOpenSessions?: () => void;
}

export function SessionTopBar({
  session,
  project,
  compact,
  actions,
  status,
  menuItems,
  onOpenSessions,
}: SessionTopBarProps) {
  const name = sessionDisplayName(session);
  const task = session.config.label ?? session.config.name;
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const openMenu = (): void => {
    const rect = moreRef.current?.getBoundingClientRect();
    setMenu({ x: rect?.right ?? 0, y: rect?.bottom ?? 0 });
  };
  // The runtime line is a fact, not an action: a disabled first row reads it out with the menu and
  // cannot be activated.
  const runtime: ContextMenuItem = {
    key: 'runtime',
    label: sessionRuntimeLine(session),
    disabled: true,
    onSelect: () => undefined,
  };

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
        {project === null || compact ? null : <span className="fy-session-bar__project">{project}</span>}
        <span className="fy-session-bar__status" data-session-status={session.state.status}>
          <StatusMark view={session} />
          <span className={compact ? 'sr-only' : 'fy-session-bar__word'}>
            {sessionStatusLabel(session.state.status)}
          </span>
          {status}
        </span>
      </div>
      <div className="fy-session-bar__actions" data-session-actions="">
        {actions}
      </div>
      <button
        aria-expanded={menu !== null}
        aria-haspopup="menu"
        aria-label="More session actions"
        className="fy-session-bar__icon"
        data-session-more=""
        onClick={openMenu}
        ref={moreRef}
        type="button"
      >
        <Ellipsis aria-hidden="true" size={18} />
      </button>
      <ContextMenu
        anchor={menu ?? { x: 0, y: 0 }}
        ariaLabel={`${name} actions`}
        items={[runtime, ...menuItems]}
        onClose={() => setMenu(null)}
        open={menu !== null}
        touch={compact}
        triggerRef={moreRef}
      />
    </header>
  );
}
