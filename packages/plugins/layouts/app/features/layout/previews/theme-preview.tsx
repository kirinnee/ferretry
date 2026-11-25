/**
 * THE PREVIEW BESIDE THE THEME CHOICE: a little window painted with the theme in use. A theme that sets colours is drawn
 * once for each mode it sets them for (light, dark), the tokens laid on that pane exactly as the shell lays them on the page;
 * a theme that sets none (the built-in default) leaves the device's own colours, so one pane draws those.
 */
import { SettingPreview } from '@ferretry/app';
import type { CSSProperties } from 'react';
import { COLOUR_TOKENS, type Theme } from '../../../../contract/index.ts';
import './previews.css';

type Mode = 'light' | 'dark';

/** The colour tokens a theme sets for one mode, as the custom properties the stylesheet reads. */
function paint(theme: Theme, mode: Mode): CSSProperties {
  const tokens = theme[mode] as Partial<Record<string, string>>;
  const style: Record<string, string> = {};
  for (const token of COLOUR_TOKENS) {
    const value = tokens[token];
    if (value !== undefined) style[`--${token}`] = value;
  }
  return style as CSSProperties;
}

function Pane({ style, mode }: { readonly style?: CSSProperties; readonly mode: Mode | 'device' }) {
  return (
    <div className="fy-ls-theme-pane" data-mode={mode} style={style}>
      <span className="fy-ls-theme-bar" />
      <span className="fy-ls-theme-line" />
      <span className="fy-ls-theme-line fy-ls-theme-line--short" />
      <span className="fy-ls-theme-chip" />
    </div>
  );
}

export function ThemePreview({ theme }: { readonly theme: Theme }) {
  const panes = (['light', 'dark'] as const).filter(mode => Object.keys(paint(theme, mode)).length > 0);
  return (
    <SettingPreview
      className="fy-ls"
      label={`Theme: ${theme.label}`}
      value={theme.id}
      after={
        <div className="fy-ls-scene">
          <div className="fy-ls-frame fy-ls-theme">
            {panes.length === 0 ? (
              <Pane mode="device" />
            ) : (
              panes.map(mode => <Pane key={mode} mode={mode} style={paint(theme, mode)} />)
            )}
          </div>
        </div>
      }
    />
  );
}
