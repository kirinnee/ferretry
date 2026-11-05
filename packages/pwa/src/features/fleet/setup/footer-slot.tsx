/**
 * The pinned footer's one primary button (simpler onboarding: every page is Back · Skip · ONE primary).
 *
 * A step that has its own action (Import, Save keys) renders it with {@link PrimaryAction}: it lands in
 * the footer the rail owns, so the step and the footer never show two primaries. Rendered outside a
 * footer (a step mounted alone) it stays where it is, so the step still works on its own.
 *
 * A form in the body can have an action of its own (Sign in, Add a provider key, Create a runtime) that
 * carries the reviewed change's passkey line and refusal text. While one is open it calls
 * {@link useQuietFooter}: the step's own action and the footer's Continue step aside, and the form's
 * action becomes the footer's one primary (`<PrimaryAction lead>`, or `ChangeApplyPanel`'s `lead`). Two
 * forms open together are ordered by who opened first: that one leads, the later ones draw their buttons
 * as plain ones in the body, so a page never shows two primaries.
 *
 * A step whose settings are edited in place (Warden, Agent controls) does not save behind the person's
 * back and does not drop an edit either: it reports the edit with {@link usePendingSave}, and the footer's
 * Continue becomes `Save and continue`, which saves it and moves on only when the save went through.
 */

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../../../shell/primitives.tsx';

export const FooterSlotContext = createContext<HTMLElement | null>(null);

export interface FooterQuiet {
  /** True while a form in the body owns the page's primary. */
  readonly quiet: boolean;
  /** The form that opened first and so keeps the body's primary, or `undefined` while none is open. */
  readonly leader: string | undefined;
  /** Take the primary for a form; the returned function gives it back. */
  readonly claim: (id: string) => () => void;
}

/** No footer around: nothing to quiet. */
export const FooterQuietContext = createContext<FooterQuiet>({
  quiet: false,
  leader: undefined,
  claim: () => () => undefined,
});

/** The footer's quiet state, kept by the rail and handed to the step bodies through {@link FooterQuietContext}. */
export function useFooterQuietState(): FooterQuiet {
  const [claims, setClaims] = useState<readonly string[]>([]);
  const claim = useCallback((id: string) => {
    setClaims(list => [...list, id]);
    return () => setClaims(list => list.filter(held => held !== id));
  }, []);
  const leader = claims[0];
  return useMemo(() => ({ quiet: claims.length > 0, leader, claim }), [claims.length, leader, claim]);
}

/**
 * While `active`, this form owns the page's primary. Returns whether it leads: false when another open
 * form claimed the page first, and then its buttons are plain ones.
 */
export function useQuietFooter(active: boolean): boolean {
  const { claim, leader } = useContext(FooterQuietContext);
  const id = useId();
  useLayoutEffect(() => (active ? claim(id) : undefined), [active, claim, id]);
  return !active || leader === undefined || leader === id;
}

/** An edit made in place, waiting for the footer's `Save and continue`. */
export interface PendingSave {
  /** It can be sent now: nothing invalid, nothing in flight, not refused. */
  readonly ready: boolean;
  /** Save it; true when it went through (a refusal says why in the body). */
  readonly save: () => Promise<boolean>;
}

/** Where a step reports its unsaved edit; `null` outside setup, where each form keeps its own Save. */
export const FooterSaveContext = createContext<((id: string, pending: PendingSave | null) => void) | null>(null);

/** The rail's list of unsaved edits, handed to the steps through {@link FooterSaveContext}. */
export function usePendingSavesState(): {
  readonly saves: readonly PendingSave[];
  readonly report: (id: string, pending: PendingSave | null) => void;
} {
  const [held, setHeld] = useState<ReadonlyMap<string, PendingSave>>(() => new Map());
  const report = useCallback((id: string, pending: PendingSave | null) => {
    setHeld(current => {
      const next = new Map(current);
      if (pending === null) next.delete(id);
      else next.set(id, pending);
      return next;
    });
  }, []);
  const saves = useMemo(() => [...held.values()], [held]);
  return { saves, report };
}

/**
 * Report an edit that is not saved yet. Returns true when a setup footer saves it (`Save and continue`),
 * so the form draws no Save of its own; false outside setup.
 */
export function usePendingSave(pending: boolean, ready: boolean, save: () => Promise<boolean>): boolean {
  const report = useContext(FooterSaveContext);
  const id = useId();
  const latest = useRef(save);
  latest.current = save;
  useLayoutEffect(() => {
    if (report === null || !pending) return undefined;
    report(id, { ready, save: () => latest.current() });
    return () => report(id, null);
  }, [report, id, pending, ready]);
  return report !== null;
}

function StepPrimary({ children }: { readonly children: ReactNode }) {
  const slot = useContext(FooterSlotContext);
  return slot === null ? <>{children}</> : createPortal(children, slot);
}

export function PrimaryAction({
  label,
  disabled = false,
  onClick,
  name,
  lead = false,
}: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  /** The `data-onboarding-primary` value, so a test or the harness can name the action. */
  readonly name?: string;
  /** An open form's own action: it IS the page's primary while the form leads. */
  readonly lead?: boolean;
}) {
  const { quiet } = useContext(FooterQuietContext);
  // A form in the body leads the page: the step's own action steps aside until it closes.
  if (quiet && !lead) return null;
  return (
    <StepPrimary>
      <Button
        type="button"
        variant="primary"
        disabled={disabled}
        data-onboarding-primary={name ?? ''}
        data-change-submit=""
        onClick={onClick}
      >
        {label}
      </Button>
    </StepPrimary>
  );
}
