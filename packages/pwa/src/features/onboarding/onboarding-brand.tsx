/**
 * THE ONE PLACE the setup screen names Ferretry with a mark beside it.
 *
 * A single seam on purpose: the Fleet Grid mark is owned by
 * `shell/brand-mark.tsx`, so onboarding reuses that component instead of
 * installing or maintaining a second copy of the mark.
 *
 * The mark is decorative here: it sits beside visible "Ferretry" text, so the
 * wordmark carries the accessible name.
 */

import { BrandMark } from '../../shell/brand-mark.tsx';

export function OnboardingBrand() {
  return (
    <div className="flex items-center gap-2 text-accent">
      <BrandMark size={20} />
      <span className="text-meta font-semibold uppercase tracking-label">Ferretry</span>
    </div>
  );
}
