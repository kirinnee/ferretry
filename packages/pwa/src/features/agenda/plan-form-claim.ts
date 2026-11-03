/**
 * A plan form (a host drawn in the card's answer slot) says whether it took the card over. Over `owns`, the card draws
 * no generic "What I need from you", no "Not needed" and no context: the form is the whole ask. Over `fallback`, the host
 * could not draw (a device that may not read accounts, a proposal that is gone) and the card is the plain one it always was.
 * A form that says nothing leaves the card as it is.
 */

import { createContext, useContext, useEffect } from 'react';

export type PlanFormClaim = 'owns' | 'fallback';

export const PlanFormClaimContext = createContext<((claim: PlanFormClaim | null) => void) | null>(null);

/** Tells the card around this host what the host is doing; forgets it when the host goes. */
export function useClaimPlanForm(claim: PlanFormClaim): void {
  const set = useContext(PlanFormClaimContext);
  useEffect(() => {
    set?.(claim);
    return () => set?.(null);
  }, [set, claim]);
}
