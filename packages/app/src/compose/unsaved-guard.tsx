/**
 * THE UNSAVED-CHANGES GUARD: leaving a settings page with something typed that no Save bar has saved asks first.
 *
 * Done ONCE, in the shared kit, so every settings form (Security, Warden, Budgets, and the next page) is covered without a line of its own:
 *   - `SettingSaveBar` reports its form's `dirty` here (`useReportUnsaved`), so a page never wires it;
 *   - the shell wraps a settings page in `UnsavedChangesGuard`, and the shell's `Link` and the phone's Back go through `useAskBeforeLeaving`;
 *   - leaving with a dirty form opens "Discard unsaved changes?" (Keep editing / Discard); leaving a clean page never asks.
 * Outside a guard (a form drawn in a test, or in a dialog) every hook is a plain pass-through.
 */

import { createContext, type ReactNode, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button } from '../ui/primitives.tsx';
import { Dialog } from '../ui/dialog.tsx';

interface UnsavedGuard {
  /** A form says whether it holds unsaved changes. */
  readonly report: (id: string, dirty: boolean) => void;
  /** Runs `proceed` now when nothing is unsaved; otherwise asks first and runs it only on Discard. */
  readonly ask: (proceed: () => void) => void;
}

const GuardContext = createContext<UnsavedGuard | null>(null);

export function UnsavedChangesGuard({ children }: { readonly children: ReactNode }) {
  const dirtyForms = useRef(new Set<string>());
  const [waiting, setWaiting] = useState<(() => void) | null>(null);
  const guard = useMemo<UnsavedGuard>(
    () => ({
      report: (id, dirty) => {
        if (dirty) dirtyForms.current.add(id);
        else dirtyForms.current.delete(id);
      },
      ask: proceed => {
        if (dirtyForms.current.size === 0) proceed();
        else setWaiting(() => proceed);
      },
    }),
    [],
  );
  const close = (): void => setWaiting(null);
  return (
    <GuardContext.Provider value={guard}>
      {children}
      <Dialog
        open={waiting !== null}
        onClose={close}
        title="Discard unsaved changes?"
        width="28rem"
        footer={
          <>
            <Button type="button" variant="primary" data-unsaved-keep="" className="min-h-[44px]" onClick={close}>
              Keep editing
            </Button>
            <Button
              type="button"
              variant="danger"
              data-unsaved-discard=""
              className="min-h-[44px]"
              onClick={() => {
                const leave = waiting;
                close();
                leave?.();
              }}
            >
              Discard
            </Button>
          </>
        }
      >
        <p className="m-0 text-ui text-fg" data-unsaved-words="">
          What you changed on this page is not saved yet. If you leave now it is lost.
        </p>
      </Dialog>
    </GuardContext.Provider>
  );
}

/** A form tells the guard whether it holds unsaved changes (`SettingSaveBar` does this itself). */
export function useReportUnsaved(dirty: boolean): void {
  const guard = useContext(GuardContext);
  const id = useId();
  useEffect(() => {
    guard?.report(id, dirty);
    return () => guard?.report(id, false);
  }, [guard, id, dirty]);
}

/** `leave(proceed)`: run `proceed` (a navigation) now, or after "Discard" when a form on this page holds unsaved changes. */
export function useAskBeforeLeaving(): (proceed: () => void) => void {
  const guard = useContext(GuardContext);
  return guard === null ? proceed => proceed() : guard.ask;
}
