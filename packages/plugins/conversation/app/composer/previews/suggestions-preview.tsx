/**
 * Suggestions preview — the trigger typed into a mini composer, then the menu popping open above it. The `@` ladder
 * types `@@` for agents; the symbols (and both) type `:`. With `$` skills on, a skill row joins the menu.
 */

import { SettingPreview } from '@ferretry/app';
import type { SuggestionKeys } from '@ferretry/app';
import './previews.css';

const TRIGGER: Readonly<Record<SuggestionKeys, string>> = { ladder: '@@', symbols: ':', both: ':' };

const LABEL: Readonly<Record<SuggestionKeys, string>> = {
  ladder: 'Typing @@ opens the agents menu',
  symbols: 'Typing : opens the agents menu',
  both: 'Either way opens the agents menu',
};

function Composer({ trigger, active }: { readonly trigger: string; readonly active: boolean }) {
  return (
    <div className={active ? 'fy-cvp-box fy-cvp-box--active' : 'fy-cvp-box'}>
      <div className="fy-cvp-line">
        hey <span className="fy-cvp-typed">{trigger}</span>
        <span className="fy-cvp-caret" />
      </div>
    </div>
  );
}

function Row({ hot, glyph }: { readonly hot?: boolean; readonly glyph?: string }) {
  return (
    <div className={hot === true ? 'fy-cvp-row fy-cvp-row--hot' : 'fy-cvp-row'}>
      {glyph === undefined ? <span className="fy-cvp-dot" /> : <span className="fy-cvp-faint">{glyph}</span>}
      <span className="fy-cvp-bar" />
    </div>
  );
}

export function SuggestionsPreview({ keys, skills }: { readonly keys: SuggestionKeys; readonly skills: boolean }) {
  const trigger = TRIGGER[keys];
  return (
    <SettingPreview
      label={LABEL[keys]}
      value={`${keys}-${skills ? 'skills' : 'noskills'}`}
      before={
        <div className="fy-cvp">
          <Composer trigger={trigger} active />
        </div>
      }
      after={
        <div className="fy-cvp">
          <div className="fy-cvp-pop">
            <div className="fy-cvp-pop-title">Agents</div>
            <Row hot />
            <Row />
            {skills ? <Row glyph="$" /> : null}
          </div>
          <Composer trigger={trigger} active />
        </div>
      }
    />
  );
}
