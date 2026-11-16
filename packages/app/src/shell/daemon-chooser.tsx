import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ChooseDaemonOptions, ChosenDaemon } from '../connect/provides.ts';
import { distinctDaemonName } from '../daemons/machine-names.ts';
import { BottomSheet } from '../ui/bottom-sheet.tsx';
import { useRuntimeVersion, useShell } from './context.tsx';
import { useFrameRoot } from './frame-root.tsx';
import type { ShellRuntime } from './runtime.ts';

/**
 * A DAEMON-LESS SCREEN MAY ASK FOR A MACHINE (shell contract S10). The shell draws its own picker (the paired machines
 * where the plugin is on, the purpose as its heading) and answers ONLY the machine the person chose, with that plugin's
 * own client on it. Nothing is chosen for the person: it never resolves without a click, and a cancel (or leaving the
 * screen) answers `undefined`.
 *
 * ONE EXCEPTION, opt-in per call: `answerAloneWhenOne` answers at once, no picker, only when exactly ONE machine is
 * paired at all (v4's rule: it counted every connection record) and it qualifies by the picker's own rule (connected,
 * inventory read, plugin on). A second paired machine in ANY state asks. Only `/shared` Install asks it; a question
 * without it always draws the picker, even with one machine. The click that opened the question is still the person's.
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
  readonly chooseDaemon: (purpose: string, options?: ChooseDaemonOptions) => Promise<ChosenDaemon | undefined>;
  /** The picker while a question is open, else nothing: portalled to the frame root, outside `WithoutShell`. */
  readonly picker: ReactNode;
}

/**
 * The machines the picker lists, and the ones it is told apart among. ONE rule for the picker and for
 * `answerAloneWhenOne`: a paired machine counts only while this plugin's client on it is answered, which is
 * `undefined` before the machine answers (down) and while the plugin is off there.
 */
function qualifying(runtime: ShellRuntime, plugin: string) {
  const everyone = runtime.daemons.snapshot().daemons;
  return { everyone, machines: everyone.filter(paired => runtime.client(paired.daemon, plugin) !== undefined) };
}

/** The answer for one machine with this plugin's own client on it; `undefined` when either is not there to take. */
function answerFor(runtime: ShellRuntime, plugin: string, daemon: string): ChosenDaemon | undefined {
  const paired = runtime.daemons.get(daemon);
  const client = runtime.client(daemon, plugin);
  if (paired === undefined || client === undefined) return undefined;
  return { daemon, machine: distinctDaemonName(paired, runtime.daemons.snapshot().daemons), client };
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
    (purpose: string, options?: ChooseDaemonOptions): Promise<ChosenDaemon | undefined> =>
      new Promise(resolve => {
        // One question at a time: a new one cancels the one still open.
        open.current?.settle(undefined);
        open.current = null;
        setAsking(null);
        // Opt-in, per call: with EXACTLY ONE qualifying machine the shell answers alone and draws no picker. Zero or
        // several ask as ever. The caller's own click started this question; nothing here acts without it.
        if (options?.answerAloneWhenOne === true) {
          const { everyone, machines } = qualifying(runtime, plugin);
          // v4's rule: alone only when ONE machine is paired at all. Any second paired machine, whatever its state
          // (connecting, unreachable, refused, unreadable, plugin off), could be the one the person means: ask.
          const only = everyone.length === 1 && machines.length === 1 ? machines[0] : undefined;
          const alone = only === undefined ? undefined : answerFor(runtime, plugin, only.daemon);
          if (alone !== undefined) {
            releases.current.push(runtime.passkeyOnScreen.choose(alone.daemon));
            resolve(alone);
            return;
          }
        }
        const next: Asking = { purpose, settle: resolve };
        open.current = next;
        setAsking(next);
      }),
    [runtime, plugin],
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
  const { everyone, machines } = qualifying(runtime, plugin);
  const choose = (daemon: string): void => {
    // Look the machine and its client up first: the override is taken only for a choice that is really answered.
    const answer = answerFor(runtime, plugin, daemon);
    if (answer === undefined) return;
    releases.current.push(runtime.passkeyOnScreen.choose(daemon));
    close(answer);
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
