/**
 * "+ NEW" WHEN THE LIST SHOWS MORE THAN ONE MACHINE: it asks which machine the session starts on.
 *
 * The machine on screen is first and marked "this one", so the default is one tap away and where it
 * always was. With a single machine there is nothing to ask, and the caller keeps its plain link.
 *
 * The trigger is a `button` drawn with whatever class the caller's "+ New" already wore, so the bar's
 * icon and the dashboard's pill keep their own look; only what a press does changes.
 *
 * A MACHINE THAT IS DOWN IS NOT THE DEFAULT. When the machine on screen is not reachable, the first row
 * — the one-tap default — is the first machine that is, and the one that is down stays listed but
 * unavailable, saying why. One asleep machine must never make "+ New" a dead end.
 */

import { type ReactNode, useRef, useState } from 'react';
import { useInputModality } from '../hooks/use-input-modality.ts';
import type { ListReach } from '../lib/all-machines.ts';
import type { DaemonId } from '../lib/daemon-connection.ts';
import { daemonNewSessionPath } from '../lib/pages/routes.ts';
import { ContextMenu, type ContextMenuItem, type MenuAnchor } from './context-menu.tsx';

/** A machine a new session could start on. */
export interface NewSessionMachine {
  readonly daemonId: DaemonId;
  readonly name: string;
  /** Set when a session cannot start there now: the reason the menu shows on its disabled row. */
  readonly unavailable?: string;
}

/** The reason an offline machine's row gives. */
export const unreachableReason = (name: string): string => `${name} isn’t reachable right now`;

/**
 * The machines with each one's reach applied: a machine the list reads as offline cannot take a new
 * session. A machine with no reach known is left available — "+ New" is never disabled on a guess.
 */
export const withReach = (
  machines: readonly NewSessionMachine[],
  reach: readonly { readonly daemonId: DaemonId; readonly reach: ListReach }[] | undefined,
): readonly NewSessionMachine[] => {
  if (reach === undefined) return machines;
  const offline = new Set(reach.filter(source => source.reach === 'offline').map(source => source.daemonId));
  return machines.map(machine =>
    offline.has(machine.daemonId) ? { ...machine, unavailable: unreachableReason(machine.name) } : machine,
  );
};

/** The one-tap default: the machine on screen while it is reachable, else the first one that is. */
export const defaultNewSessionMachine = (
  machines: readonly NewSessionMachine[],
  current: DaemonId,
): DaemonId | null => {
  const reachable = machines.filter(machine => machine.unavailable === undefined);
  return (reachable.find(machine => machine.daemonId === current) ?? reachable[0])?.daemonId ?? null;
};

/**
 * The menu's rows: the default first — the machine on screen, unless it is down — then the rest in the
 * order given. A machine that is down stays listed, disabled, with its reason under it.
 */
export const newSessionMenuItems = (
  machines: readonly NewSessionMachine[],
  current: DaemonId,
  onNavigate: (to: string) => void,
): readonly ContextMenuItem[] => {
  const first = defaultNewSessionMachine(machines, current) ?? current;
  return [
    ...machines.filter(machine => machine.daemonId === first),
    ...machines.filter(machine => machine.daemonId !== first),
  ].map(machine => ({
    key: String(machine.daemonId),
    label: machine.name,
    ...(machine.daemonId === current ? { detail: 'this one' } : {}),
    ...(machine.unavailable === undefined ? {} : { disabled: true, hint: machine.unavailable }),
    onSelect: () => onNavigate(daemonNewSessionPath(machine.daemonId)),
  }));
};

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
