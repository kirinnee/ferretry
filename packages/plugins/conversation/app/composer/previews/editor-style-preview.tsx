/**
 * Editor style samples — the same two lines drawn the way each style draws them, for the Editor style cards
 * (`ChoiceSample`, `@ferretry/app`): Markdown keeps its markers faintly visible, Rich text hides them and shows a toolbar, a
 * plain text box leaves the text exactly as typed. Every card rests on its own style; choosing one plays the card's one fade.
 */

import { ChoiceSample, type ChoiceSampleSize } from '@ferretry/app';
import type { MdComposePref } from '@ferretry/app';
import './previews.css';

/** The shape every Editor style sample is drawn in. */
const EDITOR_SAMPLE_SIZE: ChoiceSampleSize = { width: 160, height: 100 };

function Styled({ pref }: { readonly pref: MdComposePref }) {
  if (pref === 'off') {
    return (
      <div className="fy-cvp">
        <div className="fy-cvp-page fy-cvp-mono">
          <div className="fy-cvp-line"># Plan</div>
          <div className="fy-cvp-line">
            **ship** it
            <span className="fy-cvp-caret" />
          </div>
        </div>
      </div>
    );
  }
  const rich = pref === 'rich';
  return (
    <div className="fy-cvp">
      {rich ? (
        <div className="fy-cvp-tools">
          <span className="fy-cvp-tool fy-cvp-b">B</span>
          <span className="fy-cvp-tool">I</span>
          <span className="fy-cvp-tool">•</span>
        </div>
      ) : null}
      <div className={rich ? 'fy-cvp-page fy-cvp-page--tools' : 'fy-cvp-page'}>
        <div className="fy-cvp-h">{rich ? null : <span className="fy-cvp-faint"># </span>}Plan</div>
        <div className="fy-cvp-line">
          {rich ? null : <span className="fy-cvp-faint">**</span>}
          <span className="fy-cvp-b">ship</span>
          {rich ? null : <span className="fy-cvp-faint">**</span>} it
          <span className="fy-cvp-caret" />
        </div>
      </div>
    </div>
  );
}

export function EditorStyleSample({ pref }: { readonly pref: MdComposePref }) {
  return (
    <ChoiceSample size={EDITOR_SAMPLE_SIZE}>
      <Styled pref={pref} />
    </ChoiceSample>
  );
}
