/**
 * Editor style preview — the same two typed lines, raw while they go in, then drawn the way the chosen style draws
 * them: Markdown keeps its markers faintly visible, Rich text hides them and shows a toolbar, a plain text box
 * leaves the text exactly as typed.
 */

import { SettingPreview } from '@ferretry/app';
import type { MdComposePref } from '@ferretry/app';
import './previews.css';

const LABEL: Readonly<Record<MdComposePref, string>> = {
  on: 'Formats as you type, markers kept faintly visible',
  rich: 'Formats as you type, markers hidden, with a toolbar',
  off: 'Plain text, exactly as typed',
};

/** What is typed, before any style has touched it. */
function Raw() {
  return (
    <div className="fy-cvp">
      <div className="fy-cvp-page fy-cvp-mono">
        <div className="fy-cvp-line">
          <span className="fy-cvp-typed fy-cvp-typed--first"># Plan</span>
        </div>
        <div className="fy-cvp-line">
          <span className="fy-cvp-typed fy-cvp-typed--mid">**ship** it</span>
          <span className="fy-cvp-caret" />
        </div>
      </div>
    </div>
  );
}

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

export function EditorStylePreview({ pref }: { readonly pref: MdComposePref }) {
  return <SettingPreview label={LABEL[pref]} value={pref} before={<Raw />} after={<Styled pref={pref} />} />;
}
