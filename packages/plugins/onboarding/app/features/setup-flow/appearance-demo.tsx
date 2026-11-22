/**
 * THE APPEARANCE DEMO (r11 G2, C59 O6): a small app window drawn only from the theme tokens, so it shows the look in force and
 * changes the moment a pick restyles the page: display and body type, a button and an input that carry real words (so the TEXT
 * SIZE pick reads on them), a card with its shadow, a toggle and list rows, and a MOTION strip (the style's own busy mark and a
 * sweeping bar). Decorative (the frame's demo column is `aria-hidden`).
 *
 * Motion: the window pops once per pick (re-mounted by `key`, with `data-moves`; never on mount) and the strip's bar sweeps
 * forever; both stand still when the screen may not move (`useMotionAllowed`: the OS's reduced-motion setting OR the motion pick
 * above), which the demo states as `data-moving` so a test and the stylesheet read one answer.
 */
import { Spinner, useMotionAllowed } from '@ferretry/app/ui';
import type { ReactNode } from 'react';

export function AppearanceDemo({ picks }: { readonly picks: number }): ReactNode {
  const moving = useMotionAllowed();
  return (
    <div className="fy-ad" data-appearance-demo="" data-moving={moving ? 'true' : 'false'}>
      <div key={picks} className="fy-ad__window" {...(picks === 0 ? {} : { 'data-moves': '' })}>
        <div className="fy-ad__bar">
          <i />
          <i />
          <i />
        </div>
        <div className="fy-ad__body">
          <div className="fy-ad__side">
            <span data-on="" />
            <span />
            <span />
          </div>
          <div className="fy-ad__main">
            <b className="fy-ad__display">Ag</b>
            <span className="fy-ad__text" data-appearance-demo-text="">
              Quick fox
            </span>
            <em className="fy-ad__label">Label</em>
            <span className="fy-ad__button" data-appearance-demo-accent="">
              Send
            </span>
            <span className="fy-ad__input">Message</span>
            <span className="fy-ad__card" />
            <span className="fy-ad__toggle" />
            <span className="fy-ad__row" />
            <span className="fy-ad__row" />
            <span className="fy-ad__motion" data-appearance-demo-motion="">
              <Spinner size={16} />
              <span className="fy-ad__run">
                <i />
              </span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
