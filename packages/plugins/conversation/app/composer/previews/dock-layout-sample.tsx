/**
 * Button layout samples — the phone composer drawn the way each layout lays it out, for the Button layout cards
 * (`ChoiceSample`, `@ferretry/app`). It is the REAL composer's markup and classes (`.fy-composer`, `.fy-composer-row`,
 * `.fy-composer-dock`, `.fy-composer-icon`, `.fy-composer-send`, `.fy-composer-slot`) with the phone and dock-layout
 * attributes the composer stamps, so `chat.css` draws it and the sample cannot drift from what the setting does. Spans
 * stand in for the buttons: nothing in a sample is interactive.
 *
 * Stacked and One row rest on their own final look. Auto is a story in two pictures, one above the other: side by side while
 * the box is empty, then stacked once it has a draft (both drawn by the real Auto rules, `data-composer-empty` on or off).
 * Choosing its card plays ONE movement, the second picture arriving, by CSS off `.fy-cc__card[data-pulse]`, which is never set
 * under reduced motion; it ends where it began, so nothing jumps.
 */

import { ChoiceSample, type ChoiceSampleSize } from '@ferretry/app';
import { ArrowDown, ArrowUp, Mic, Plus } from 'lucide-react';
import type { ComposerDockLayout } from '../composer-dock-layout.ts';
import './previews.css';

/** The shape every Button layout sample is drawn in (a phone-width composer, the tallest layout fitting with room). */
const DOCK_SAMPLE_SIZE: ChoiceSampleSize = { width: 300, height: 120 };

/** One phone composer. `empty` is what `data-composer-empty` means to Auto: the box has no draft. */
function MiniComposer({ layout, empty }: { readonly layout: ComposerDockLayout; readonly empty: boolean }) {
  return (
    <div
      className="fy-composer fy-dls__composer"
      data-composer-layout="phone"
      data-composer-dock-layout={layout}
      data-composer-empty={empty ? '' : undefined}
    >
      <div className="fy-composer-row">
        <div className="fy-composer-dock" data-composer-dock="start">
          <span className="fy-composer-icon">
            <Plus aria-hidden="true" size={17} />
          </span>
          <span className="fy-composer-icon">
            <Mic aria-hidden="true" size={17} />
          </span>
        </div>
        <div className="fy-composer-input-layer fy-dls__field">
          {empty ? <span className="fy-dls__hint">Message…</span> : <span>Hi there</span>}
        </div>
        <div className="fy-composer-dock" data-composer-dock="">
          <span className="fy-composer-slot" />
          <span className="fy-composer-send">
            <ArrowUp aria-hidden="true" size={18} strokeWidth={2.5} />
          </span>
        </div>
      </div>
    </div>
  );
}

export function DockLayoutSample({ layout }: { readonly layout: ComposerDockLayout }) {
  return (
    <ChoiceSample size={DOCK_SAMPLE_SIZE}>
      {layout === 'auto' ? (
        <div className="fy-dls fy-dls--auto" data-dock-sample="auto">
          <div className="fy-dls__half">
            <MiniComposer layout="auto" empty />
          </div>
          <ArrowDown aria-hidden="true" className="fy-dls__then" size={13} />
          <div className="fy-dls__half fy-dls__half--typed">
            <MiniComposer layout="auto" empty={false} />
          </div>
        </div>
      ) : (
        <div className="fy-dls" data-dock-sample={layout}>
          <div className="fy-dls__layer">
            <MiniComposer layout={layout} empty />
          </div>
        </div>
      )}
    </ChoiceSample>
  );
}
