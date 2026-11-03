/**
 * The pinned footer's one primary button (simpler onboarding: every page is Back · Skip · ONE primary).
 *
 * A step that has its own action (Import, Save keys) renders it with {@link PrimaryAction}: it lands in
 * the footer the rail owns, so the step and the footer never show two primaries. Rendered outside a
 * footer (a step mounted alone) it stays where it is, so the step still works on its own.
 */

import { createContext, type ReactNode, useContext } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../../../shell/primitives.tsx';

export const FooterSlotContext = createContext<HTMLElement | null>(null);

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
