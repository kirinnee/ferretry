import { ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { distinctDaemonName } from '../daemons/machine-names.ts';
import { daemonHomeHref, HOME_HREF } from '../router/routes.ts';
import { useRouter } from '../router/router.tsx';
import { ContextMenu, type ContextMenuItem, type MenuAnchor } from '../ui/context-menu.tsx';
import { useInputModality } from '../ui/hooks/use-input-modality.ts';
import { useRuntimeVersion, useShell } from './context.tsx';
import { hostFileIsNamed, readHostFile } from './name-machine.tsx';

/**
 * THE MACHINE SWITCHER, like v4's: a button that says which machine is on screen and opens a menu (the shared
 * ContextMenu — role=menu, arrows, Home/End, Escape back to the button, 44px rows on a touch screen). Every machine is
 * ONE row, in its own words, the one on screen marked "this one"; "All daemons" leads, marked the same way when the
 * list is what is showing.
 *
 * A machine nobody has named goes by its host name (`ip-172-27-76-90`), and that is correct, so the switcher says so
 * quietly with a "Name this machine" beside it, which offers the same short step a pairing does. No new screen.
 */

const ALL_DAEMONS = 'All daemons';
const ALL_DAEMONS_KEY = '';
const THIS_ONE = 'this one';

/**
 * Whether the machine on screen still goes by its host name: asked of the machine itself (`host.yaml` is the one place the
 * name is the owner's), once it can answer and again whenever the name this device shows changes (a rename). `false` while
 * it is not known — a machine that cannot say, or a device that may not read it, is never offered a step it could not finish.
 */
export function useGoesByHostName(daemon: string | undefined): boolean {
  const { runtime } = useShell();
  useRuntimeVersion(runtime);
  const client = daemon === undefined ? undefined : runtime.client(daemon, 'kernel');
  const shown = daemon === undefined ? undefined : runtime.daemons.get(daemon)?.machine;
  const [answer, setAnswer] = useState<{ readonly daemon: string; readonly shown: string | undefined } | undefined>(
    undefined,
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: `shown` re-asks after a rename.
  useEffect(() => {
    if (daemon === undefined || client === undefined) return undefined;
    let live = true;
    void readHostFile(client, true).then(
      file => {
        if (live) setAnswer(hostFileIsNamed(file) ? undefined : { daemon, shown });
      },
      () => {
        if (live) setAnswer(undefined);
      },
    );
    return () => {
      live = false;
    };
  }, [client, daemon, shown]);
  // Offered only while the step is not already on screen.
  return (
    daemon !== undefined && answer?.daemon === daemon && answer.shown === shown && !runtime.daemons.namePending(daemon)
  );
}

/** The machine on screen's name and the menu rows that switch machines: shared by the bar's switcher and the chat's one menu. */
export function useMachineChoices(daemon: string | undefined): {
  readonly name: string;
  readonly items: readonly ContextMenuItem[];
} {
  const { runtime } = useShell();
  const router = useRouter();
  const machines = runtime.daemons.groups().flatMap(group => group.daemons);
  const current = machines.find(entry => entry.daemon === daemon);
  // The chooser's own helper: a machine paired twice (after a daemon reset) reads differently per entry, never "pebox, pebox".
  const everyone = runtime.daemons.snapshot().daemons;
  const name = current === undefined ? ALL_DAEMONS : distinctDaemonName(current, everyone);
  if (machines.length === 0) return { name, items: [] };
  return {
    name,
    items: [
      {
        key: ALL_DAEMONS_KEY,
        label: ALL_DAEMONS,
        ...(current === undefined ? { detail: THIS_ONE } : {}),
        onSelect: () => router.navigate(HOME_HREF),
      },
      ...machines.map(entry => ({
        key: entry.daemon,
        label: distinctDaemonName(entry, everyone),
        ...(entry.daemon === current?.daemon ? { detail: THIS_ONE } : {}),
        separatorBefore: entry === machines[0],
        onSelect: () => {
          runtime.daemons.select(entry.daemon);
          router.navigate(daemonHomeHref(entry.daemon));
        },
      })),
    ],
  };
}

export function DaemonPicker({ daemon }: { readonly daemon: string | undefined }) {
  const { runtime } = useShell();
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const { touchAffected } = useInputModality();
  const { name, items } = useMachineChoices(daemon);
  const goesByHostName = useGoesByHostName(daemon);
  if (items.length === 0) return null;
  return (
    <>
      <button
        aria-expanded={anchor !== null}
        aria-haspopup="menu"
        aria-label={`Machine: ${name}. Switch machine`}
        className="fy-daemon-picker"
        data-daemon-picker=""
        onClick={() => {
          const rect = trigger.current?.getBoundingClientRect();
          setAnchor({ x: rect?.left ?? 0, y: rect?.bottom ?? 0 });
        }}
        ref={trigger}
        type="button"
      >
        <span className="fy-daemon-picker__name">{name}</span>
        <ChevronDown aria-hidden="true" size={14} />
      </button>
      {goesByHostName && daemon !== undefined ? (
        <button
          className="fy-name-machine"
          data-name-machine-offer=""
          onClick={() => runtime.daemons.askToName(daemon)}
          type="button"
        >
          Name this machine
        </button>
      ) : null}
      <ContextMenu
        anchor={anchor ?? { x: 0, y: 0 }}
        ariaLabel="Switch machine"
        items={items}
        onClose={() => setAnchor(null)}
        open={anchor !== null}
        touch={touchAffected}
        triggerRef={trigger}
      />
    </>
  );
}
