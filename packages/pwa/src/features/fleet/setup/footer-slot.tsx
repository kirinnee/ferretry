/**
 * The pinned footer's one primary button (simpler onboarding: every page is Back · Skip · ONE primary).
 *
 * A step that has its own action (Import, Save keys) renders it with {@link PrimaryAction}: it lands in
 * the footer the rail owns, so the step and the footer never show two primaries. Rendered outside a
 * footer (a step mounted alone) it stays where it is, so the step still works on its own.
 *
 * A form in the body can have a primary of its own (Save what agents may control, Create a runtime) that
 * carries the reviewed change's passkey line and refusal text, so it stays where it is. While one is open
 * it calls {@link useQuietFooter} and the footer's button steps back to a plain one: the open form owns
 * the page, and the footer is still there to move on without it. Two forms open together are ordered by
 * who opened first: that one keeps the primary and the later ones step back too, so a page never shows two.
 */

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
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
 * While `active`, the footer's primary is quiet because this form has its own. Returns whether this form
 * may draw its own button as the primary: false when another open form claimed the page first.
 */
export function useQuietFooter(active: boolean): boolean {
  const { claim, leader } = useContext(FooterQuietContext);
  const id = useId();
  useLayoutEffect(() => (active ? claim(id) : undefined), [active, claim, id]);
  return !active || leader === undefined || leader === id;
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
}: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  /** The `data-onboarding-primary` value, so a test or the harness can name the action. */
  readonly name?: string;
}) {
  const { quiet } = useContext(FooterQuietContext);
  return (
    <StepPrimary>
      <Button
        type="button"
        variant={quiet ? 'outline' : 'primary'}
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
