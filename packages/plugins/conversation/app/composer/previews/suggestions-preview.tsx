/**
 * Suggestions preview — the trigger typed into a mini composer, then the menu popping open above it. The `@` ladder
 * types `@@` for agents; the symbols (and both) type `:`. With `$` skills on, the agents menu is followed by a second,
 * SEPARATE Skills menu: `$` opens its own menu, never a row inside the agents one.
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

function Composer({
  trigger,
  skills = false,
}: {
  readonly trigger: string;
  /** Show the `$` typed after the trigger (the second menu's opener). */
  readonly skills?: boolean;
}) {
  return (
    <div className="fy-cvp-box fy-cvp-box--active">
      <div className="fy-cvp-line">
        hey <span className="fy-cvp-typed">{trigger}</span>
        {skills ? (
          <>
            {' '}
            <span className="fy-cvp-typed--skill">$</span>
          </>
        ) : null}
        <span className="fy-cvp-caret" />
      </div>
    </div>
  );
}

function Menu({
  title,
  glyph,
  className,
}: {
  readonly title: string;
  readonly glyph?: string;
  readonly className: string;
}) {
  return (
    <div className={className}>
      <div className="fy-cvp-pop-title">{title}</div>
      <Row hot glyph={glyph} />
      <Row glyph={glyph} />
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
          <Composer trigger={trigger} />
        </div>
      }
      after={
        <div className="fy-cvp">
          <Menu title="Agents" className={skills ? 'fy-cvp-pop fy-cvp-pop--agents' : 'fy-cvp-pop'} />
          {skills ? <Menu title="Skills" glyph="$" className="fy-cvp-pop fy-cvp-pop--skills" /> : null}
          <Composer trigger={trigger} skills={skills} />
        </div>
      }
    />
  );
}
