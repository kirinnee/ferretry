/**
 * "+ NEW" WHEN THE LIST SHOWS MORE THAN ONE MACHINE: it asks which machine the session starts on.
 *
 * The machine on screen is first and marked "this one", so the default is one tap away and where it
 * always was. With a single machine there is nothing to ask, and the caller keeps its plain link.
 *
 * The trigger is a `button` drawn with whatever class the caller's "+ New" already wore, so the bar's
 * icon and the dashboard's pill keep their own look; only what a press does changes.
 */

import { type ReactNode, useRef, useState } from 'react';
import { useInputModality } from '../hooks/use-input-modality.ts';
import type { DaemonId } from '../lib/daemon-connection.ts';
import { daemonNewSessionPath } from '../lib/pages/routes.ts';
import { ContextMenu, type ContextMenuItem, type MenuAnchor } from './context-menu.tsx';

/** A machine a new session could start on. */
export interface NewSessionMachine {
  readonly daemonId: DaemonId;
  readonly name: string;
}

/** The menu's rows: the machine on screen first, marked, then the rest in the order given. */
export const newSessionMenuItems = (
  machines: readonly NewSessionMachine[],
  current: DaemonId,
  onNavigate: (to: string) => void,
): readonly ContextMenuItem[] =>
  [
    ...machines.filter(machine => machine.daemonId === current),
    ...machines.filter(machine => machine.daemonId !== current),
  ].map(machine => ({
    key: String(machine.daemonId),
    label: machine.name,
    ...(machine.daemonId === current ? { detail: 'this one' } : {}),
    onSelect: () => onNavigate(daemonNewSessionPath(machine.daemonId)),
  }));

export function NewSessionMenu({
  machines,
  current,
  onNavigate,
  className,
  children,
  variant,
}: {
  readonly machines: readonly NewSessionMachine[];
  readonly current: DaemonId;
  readonly onNavigate: (to: string) => void;
  readonly className: string;
  readonly children: ReactNode;
  /** The `data-variant` the caller's link wore, kept on the button. */
  readonly variant?: string;
}) {
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const { touchAffected } = useInputModality();
  return (
    <>
      <button
        aria-expanded={anchor !== null}
        aria-haspopup="menu"
        aria-label="New session"
        className={className}
        data-new-session-menu=""
        data-variant={variant}
        onClick={() => {
          const rect = trigger.current?.getBoundingClientRect();
          setAnchor({ x: rect?.left ?? 0, y: rect?.bottom ?? 0 });
        }}
        ref={trigger}
        title="New session"
        type="button"
      >
        {children}
      </button>
      <ContextMenu
        anchor={anchor ?? { x: 0, y: 0 }}
        ariaLabel="New session on"
        items={newSessionMenuItems(machines, current, onNavigate)}
        onClose={() => setAnchor(null)}
        open={anchor !== null}
        triggerRef={trigger}
        touch={touchAffected}
      />
    </>
  );
}
