import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ChosenDaemon } from '../connect/provides.ts';
import { distinctDaemonName } from '../daemons/machine-names.ts';
import { BottomSheet } from '../ui/bottom-sheet.tsx';
import { useRuntimeVersion, useShell } from './context.tsx';
import { useFrameRoot } from './frame-root.tsx';

/**
 * A DAEMON-LESS SCREEN MAY ASK FOR A MACHINE (shell contract S10). The shell draws its own picker (the paired machines
 * where the plugin is on, the purpose as its heading) and answers ONLY the machine the person chose, with that plugin's
 * own client on it. Nothing is chosen for the person: it never resolves without a click, and a cancel (or leaving the
 * screen) answers `undefined`.
 *
 * The picker is a REAL OVERLAY: the app's `BottomSheet` (scrim, focus trap, Escape), portalled to the frame root and
 * painted above every plugin overlay. A plugin's own sheet is a `fixed` `z-40` overlay inside its screen's subtree
 * (`/shared` asks while its item sheet is open), so a picker drawn in the screen's flow would open under that sheet's
 * scrim and outside its trap, where the person can neither see nor reach it.
 *
 * Passkey (MA6): from the choice until the screen unmounts, the chosen machine counts as the machine on screen
 * (`runtime.passkeyOnScreen`), so its reads are not left waiting. The chooser never calls `focus`; only `PasskeyMount`
 * does. Leaving the screen releases every override this chooser took, each only if it is still that choice's own, and
 * the route's machine (else the selected one) is on screen again at once.
 */

/** One step above the `z-40` every plugin sheet paints at. */
const CHOOSER_Z_INDEX = 'z-50';

interface Asking {
  readonly purpose: string;
  readonly settle: (chosen: ChosenDaemon | undefined) => void;
}

export interface DaemonChooser {
  readonly chooseDaemon: (purpose: string) => Promise<ChosenDaemon | undefined>;
  /** The picker while a question is open, else nothing: portalled to the frame root, outside `WithoutShell`. */
  readonly picker: ReactNode;
}

export function useDaemonChooser(plugin: string): DaemonChooser {
  const { runtime } = useShell();
  useRuntimeVersion(runtime);
  const frameRoot = useFrameRoot();
  const headingId = useId();
  const [asking, setAsking] = useState<Asking | null>(null);
  const open = useRef<Asking | null>(null);
  const releases = useRef<(() => void)[]>([]);

  const close = useCallback((answer: ChosenDaemon | undefined): void => {
    const current = open.current;
    open.current = null;
    setAsking(null);
    current?.settle(answer);
  }, []);

  const chooseDaemon = useCallback(
    (purpose: string): Promise<ChosenDaemon | undefined> =>
      new Promise(resolve => {
        // One question at a time: a new one cancels the one still open.
        open.current?.settle(undefined);
        const next: Asking = { purpose, settle: resolve };
        open.current = next;
        setAsking(next);
      }),
    [],
  );

  useEffect(
    () => () => {
      open.current?.settle(undefined);
      open.current = null;
      for (const release of releases.current.splice(0)) release();
    },
    [],
  );

  if (asking === null) return { chooseDaemon, picker: null };
  const everyone = runtime.daemons.snapshot().daemons;
  const machines = everyone.filter(paired => runtime.client(paired.daemon, plugin) !== undefined);
  const choose = (daemon: string): void => {
    // Look the machine and its client up first: the override is taken only for a choice that is really answered.
    const paired = runtime.daemons.get(daemon);
    const client = runtime.client(daemon, plugin);
    if (paired === undefined || client === undefined) return;
    releases.current.push(runtime.passkeyOnScreen.choose(daemon));
    close({ daemon, machine: distinctDaemonName(paired, everyone), client });
  };
  return {
    chooseDaemon,
    picker: createPortal(
      <BottomSheet
        id={`fy-chooser-${headingId}`}
        open
        onClose={() => close(undefined)}
        labelledBy={headingId}
        closeLabel="Cancel"
        zIndexClass={CHOOSER_Z_INDEX}
        panelClassName="gap-sm p-md"
      >
        <div className="fy-chooser flex min-w-0 flex-col gap-sm" data-chooser="">
          <h2 id={headingId} className="m-0 text-base">
            {asking.purpose}
          </h2>
          {machines.length === 0 ? (
            <p className="fy-shell-line fy-shell-line--info m-0" role="status" data-chooser-none="">
              No paired machine can do this yet.
            </p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-xs p-0">
              {machines.map(paired => (
                <li key={paired.daemon}>
                  <button type="button" data-chooser-machine={paired.daemon} onClick={() => choose(paired.daemon)}>
                    {distinctDaemonName(paired, everyone)}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button type="button" data-chooser-cancel="" onClick={() => close(undefined)}>
            Cancel
          </button>
        </div>
      </BottomSheet>,
      frameRoot,
    ),
  };
}
