/**
 * "+ NEW FERRET" WHEN THE APP HOLDS MORE THAN ONE MACHINE (S-0159): it asks which machine the ferret starts on.
 *
 * The machine on screen is first and marked "this one", so the default is one tap away and where it always was. With a
 * single machine there is nothing to ask, and the list keeps its plain link.
 *
 * A MACHINE THAT IS DOWN IS NOT THE DEFAULT. When the machine on screen is not reachable, the first row — the one-tap
 * default — is the first machine that is, and the one that is down stays listed but unavailable, saying why. One asleep
 * machine must never make "+ New" a dead end.
 */
import { type DaemonReach, useEveryDaemon } from '@ferretry/app';
import { ContextMenu, type ContextMenuItem, type MenuAnchor, useInputModality } from '@ferretry/app/ui';
import { type ReactNode, useRef, useState } from 'react';
import { newFerretHref } from './hrefs.ts';

/** A machine a new ferret could start on. */
export interface NewFerretMachine {
  readonly daemon: string;
  readonly name: string;
  /** Set when a ferret cannot start there now: the reason the menu shows on its disabled row. */
  readonly unavailable?: string;
}

/** The reason an offline machine's row gives. */
const unreachableReason = (name: string): string => `${name} isn’t reachable right now`;

/** The machines the app reaches, each one's reach applied: a machine whose feed is down cannot take a new ferret. */
export const newFerretMachines = (
  rows: readonly Pick<DaemonReach, 'daemon' | 'machine' | 'online'>[],
): readonly NewFerretMachine[] =>
  rows.map(row => ({
    daemon: row.daemon,
    name: row.machine,
    ...(row.online ? {} : { unavailable: unreachableReason(row.machine) }),
  }));

/** The one-tap default: the machine on screen while it is reachable, else the first one that is. */
export const defaultNewFerretMachine = (machines: readonly NewFerretMachine[], current: string): string | undefined => {
  const reachable = machines.filter(machine => machine.unavailable === undefined);
  return (reachable.find(machine => machine.daemon === current) ?? reachable[0])?.daemon;
};

/**
 * The menu's rows: the default first — the machine on screen, unless it is down — then the rest in the order given. A
 * machine that is down stays listed, disabled, with its reason under it.
 */
export const newFerretMenuItems = (
  machines: readonly NewFerretMachine[],
  current: string,
  onNavigate: (to: string) => void,
): readonly ContextMenuItem[] => {
  const first = defaultNewFerretMachine(machines, current) ?? current;
  return [
    ...machines.filter(machine => machine.daemon === first),
    ...machines.filter(machine => machine.daemon !== first),
  ].map(machine => ({
    key: machine.daemon,
    label: machine.name,
    ...(machine.daemon === current ? { detail: 'this one' } : {}),
    ...(machine.unavailable === undefined ? {} : { disabled: true, hint: machine.unavailable }),
    onSelect: () => onNavigate(newFerretHref(machine.daemon)),
  }));
};

/**
 * The list's "+ New ferret": a link to the machine on screen's new-ferret page while the app reaches one machine (or
 * none), a button asking which machine while it reaches several.
 */
export function NewFerretButton({
  daemon,
  onNavigate,
}: {
  readonly daemon: string;
  readonly onNavigate: ((to: string) => void) | undefined;
}): ReactNode {
  const machines = newFerretMachines(useEveryDaemon());
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const { touchAffected } = useInputModality();
  if (machines.length < 2 || onNavigate === undefined)
    return (
      <a className="kt-btn" data-ferret-new="" data-variant="primary" href={newFerretHref(daemon)}>
        + New ferret
      </a>
    );
  return (
    <>
      <button
        aria-expanded={anchor !== null}
        aria-haspopup="menu"
        className="kt-btn"
        data-ferret-new=""
        data-new-ferret-machines=""
        data-variant="primary"
        onClick={() => {
          const rect = trigger.current?.getBoundingClientRect();
          setAnchor({ x: rect?.left ?? 0, y: rect?.bottom ?? 0 });
        }}
        ref={trigger}
        type="button"
      >
        + New ferret
      </button>
      <ContextMenu
        anchor={anchor ?? { x: 0, y: 0 }}
        ariaLabel="New ferret on"
        items={newFerretMenuItems(machines, daemon, onNavigate)}
        onClose={() => setAnchor(null)}
        open={anchor !== null}
        touch={touchAffected}
        triggerRef={trigger}
      />
    </>
  );
}
