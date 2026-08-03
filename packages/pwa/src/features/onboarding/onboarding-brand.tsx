/**
 * THE ONE PLACE the setup screen names Ferretry with a mark beside it.
 *
 * A single seam on purpose: the Fleet Grid mark is being installed by a
 * separate unit as `shell/brand-mark.tsx`'s `BrandMark`, and the swap should be
 * one component body, not a search across four stages. Until that lands this
 * keeps the pairing screen's existing treatment, so nothing here depends on an
 * asset that is not in the tree yet — and no second copy of the mark is created.
 *
 * The mark is decorative in both worlds: it sits beside visible "Ferretry"
 * text, so it is `aria-hidden` and the wordmark carries the accessible name.
 */

import { Radio } from 'lucide-react';

export function OnboardingBrand() {
  return (
    <div className="flex items-center gap-2 text-accent">
      <Radio size={20} aria-hidden="true" />
      <span className="text-meta font-semibold uppercase tracking-label">Ferretry</span>
    </div>
  );
}
