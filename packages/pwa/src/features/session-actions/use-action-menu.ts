/**
 * The behaviour every actions menu shares — the header's Actions ▾ dropdown and the sessions bar's
 * right-click menu / long-press sheet: which row is confirming, which is pending, choosing, the
 * menu-pattern keyboard, and dismissal (Escape one layer at a time, a press outside, a resize).
 * Drawing and placement stay with each surface.
 */

import {
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { isTopEscapeLayer, pushEscapeLayer } from '../../hooks/use-dialog-focus.ts';
import type { SessionActionEntry } from './registry.ts';
import { DetailedFailure } from './session-operations.ts';

const failureSentence = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason));

export interface ActionMenuOptions {
  readonly open: boolean;
  /** Closes the menu; `restoreFocus` asks the surface to hand focus back to whatever opened it. */
  readonly close: (restoreFocus: boolean) => void;
  /** A "…" row was chosen: the surface closes itself and shows the form. */
  readonly openForm: (actionId: string) => void;
  readonly onFailure?: ((sentence: string, detail?: string) => void) | undefined;
  /** A press inside this element is not "outside" (the trigger button). */
  readonly insideRef?: RefObject<HTMLElement | null>;
  /** Presses outside and resizes dismiss a floating menu; a modal sheet dismisses itself. */
  readonly dismissOnOutside?: boolean;
}

export function useActionMenu({
  open,
  close,
  openForm,
  onFailure,
  insideRef,
  dismissOnOutside = true,
}: ActionMenuOptions) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const confirmingRef = useRef<string | null>(null);
  confirmingRef.current = confirming;
  const [pending, setPending] = useState<string | null>(null);

  const dismiss = useCallback(
    (restoreFocus: boolean): void => {
      setConfirming(null);
      close(restoreFocus);
    },
    [close],
  );

  useLayoutEffect(() => {
    if (!open) return;
    const target =
      confirming === null
        ? menuRef.current?.querySelector<HTMLElement>('[data-menu-row]:not([aria-disabled="true"])')
        : menuRef.current?.querySelector<HTMLElement>('[data-menu-confirm-yes]');
    target?.focus();
  }, [open, confirming]);

  useEffect(() => {
    if (!open) return;
    const token = {};
    const release = pushEscapeLayer(token);
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || !isTopEscapeLayer(token)) return;
      event.stopPropagation();
      if (confirmingRef.current !== null) setConfirming(null);
      else dismiss(true);
    };
    const onPointer = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (menuRef.current?.contains(target) || insideRef?.current?.contains(target)) return;
      dismiss(false);
    };
    const onResize = (): void => dismiss(false);
    document.addEventListener('keydown', onKey);
    if (dismissOnOutside) {
      document.addEventListener('pointerdown', onPointer, true);
      window.addEventListener('resize', onResize);
    }
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('resize', onResize);
      release();
    };
  }, [open, dismiss, insideRef, dismissOnOutside]);

  const runSafely = async (entry: SessionActionEntry, work: () => Promise<void> | void): Promise<void> => {
    setPending(entry.id);
    try {
      await work();
    } catch (reason) {
      const sentence = `${entry.label.replace(/…$/u, '')} failed: ${failureSentence(reason)}`;
      if (reason instanceof DetailedFailure) onFailure?.(sentence, reason.detail);
      else onFailure?.(sentence);
    } finally {
      setPending(null);
    }
  };

  const choose = (entry: SessionActionEntry): void => {
    if (entry.unavailable !== undefined || pending !== null) return;
    if (entry.kind === 'form') {
      openForm(entry.id);
      return;
    }
    if (entry.kind === 'confirm') {
      setConfirming(entry.id);
      return;
    }
    if (entry.kind === 'toggle') {
      void runSafely(entry, () => entry.onToggle(!entry.checked));
      return;
    }
    dismiss(true);
    void runSafely(entry, entry.run);
  };

  const confirmRun = (entry: Extract<SessionActionEntry, { kind: 'confirm' }>): void => {
    dismiss(true);
    void runSafely(entry, entry.run);
  };

  const onMenuKey = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Tab') {
      dismiss(false);
      return;
    }
    const rows = [
      ...(menuRef.current?.querySelectorAll<HTMLElement>(
        '[data-menu-row]:not([aria-disabled="true"]), [data-menu-confirm] button',
      ) ?? []),
    ];
    if (rows.length === 0) return;
    const index = rows.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === 'ArrowDown'
        ? rows[(index + 1) % rows.length]
        : event.key === 'ArrowUp'
          ? rows[(index - 1 + rows.length) % rows.length]
          : event.key === 'Home'
            ? rows[0]
            : event.key === 'End'
              ? rows[rows.length - 1]
              : undefined;
    if (next === undefined) return;
    event.preventDefault();
    next.focus();
  };

  return { menuRef, confirming, setConfirming, pending, choose, confirmRun, onMenuKey, dismiss };
}
