import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import type { ChosenDaemon } from '../connect/provides.ts';
import { daemonTitle } from '../daemons/daemon-list.ts';
import { useRuntimeVersion, useShell } from './context.tsx';

/**
 * A DAEMON-LESS SCREEN MAY ASK FOR A MACHINE (shell contract S10). The shell draws its own picker (the paired machines
 * where the plugin is on, the purpose as its heading) and answers ONLY the machine the person chose, with that plugin's
 * own client on it. Nothing is chosen for the person: it never resolves without a click, and a cancel (or leaving the
 * screen) answers `undefined`.
 *
 * Passkey (MA6): from the choice until the screen unmounts, the chosen machine counts as the machine on screen
 * (`runtime.passkeyOnScreen`), so its reads are not left waiting. The chooser never calls `focus`; only `PasskeyMount`
 * does. Leaving the screen releases every override this chooser took, each only if it is still that choice's own, and
 * the route's machine (else the selected one) is on screen again at once.
 */

interface Asking {
  readonly purpose: string;
  readonly settle: (chosen: ChosenDaemon | undefined) => void;
}

export interface DaemonChooser {
  readonly chooseDaemon: (purpose: string) => Promise<ChosenDaemon | undefined>;
  /** The picker while a question is open, else nothing: drawn by the screen's host, outside `WithoutShell`. */
  readonly picker: ReactNode;
}

export function useDaemonChooser(plugin: string): DaemonChooser {
  const { runtime } = useShell();
  useRuntimeVersion(runtime);
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
  const machines = runtime.daemons
    .snapshot()
    .daemons.filter(paired => runtime.client(paired.daemon, plugin) !== undefined);
  const choose = (daemon: string): void => {
    const client = runtime.client(daemon, plugin);
    if (client === undefined) return;
    releases.current.push(runtime.passkeyOnScreen.choose(daemon));
    const paired = runtime.daemons.get(daemon);
    if (paired === undefined) return;
    close({ daemon, machine: daemonTitle(paired), client });
  };
  return {
    chooseDaemon,
    picker: (
      <section className="fy-chooser" role="dialog" aria-label={asking.purpose} data-chooser="">
        <h2>{asking.purpose}</h2>
        {machines.length === 0 ? (
          <p className="fy-shell-line fy-shell-line--info" role="status" data-chooser-none="">
            No paired machine can do this yet.
          </p>
        ) : (
          <ul>
            {machines.map(paired => (
              <li key={paired.daemon}>
                <button type="button" data-chooser-machine={paired.daemon} onClick={() => choose(paired.daemon)}>
                  {daemonTitle(paired)}
                </button>
              </li>
            ))}
          </ul>
        )}
        <button type="button" data-chooser-cancel="" onClick={() => close(undefined)}>
          Cancel
        </button>
      </section>
    ),
  };
}
