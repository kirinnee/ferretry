import { useEffect } from 'react';
import type { StepHost } from '@ferretry/kernel/contract';

/** Lifts the shell's loading cover once, as soon as the page has something to draw. A page with no host does nothing. */
export function useStepReady(step: StepHost | undefined): void {
  useEffect(() => {
    step?.ready();
  }, [step]);
}
