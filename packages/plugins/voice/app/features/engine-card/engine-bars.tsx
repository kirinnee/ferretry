/**
 * THREE SHORT BARS — Speed, Accuracy, Size — with the value in words beside each, so no bar ever stands alone and the
 * card can be compared at a glance without reading a paragraph.
 *
 * This is the shape P1's `OptionBars` takes (`{ bars: { label, value: 0..1 }[] }`), with two additions the voice card
 * needs: `text` (the number in words, also the screen-reader text) and `value: null` (nothing was measured).
 * TODO(r10-p1): when `app/src/compose/option-bars.tsx` lands, swap this file for it and keep `text`.
 *
 * The group is one image to a screen reader ("Speed 0.4 s. Accuracy 52%. Size 86 MB."): three decorative tracks read
 * as nothing, so the words carry the meaning.
 */

import { barsText, type EngineBar } from './engine-numbers.ts';

export function EngineBars({ bars }: { readonly bars: readonly EngineBar[] }) {
  return (
    <div className="fy-engine-bars" role="img" aria-label={barsText(bars)}>
      {bars.map(bar => (
        <div key={bar.label} className="fy-engine-bar" data-bar={bar.label.toLowerCase()}>
          <span className="fy-engine-bar-label">{bar.label}</span>
          <span className="fy-engine-bar-track" data-measured={bar.value === null ? 'no' : 'yes'}>
            {bar.value === null ? null : (
              <span className="fy-engine-bar-fill" style={{ width: `${Math.round(bar.value * 100)}%` }} />
            )}
          </span>
          <span className="fy-engine-bar-text">{bar.text}</span>
        </div>
      ))}
    </div>
  );
}
