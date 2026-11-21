/**
 * THE APPEARANCE DEMO (r11 G2): a small app window drawn only from the theme tokens, so it shows the look in force and
 * changes the moment a pick restyles the page: display and body type, a button, an input, a card with its shadow, a toggle and
 * list rows. Decorative (the frame's demo column is `aria-hidden`). It pops once per pick: the window is re-mounted
 * (`key`) with `data-moves`, and rests otherwise (never on mount, never with motion off).
 */
import type { ReactNode } from 'react';

export function AppearanceDemo({ picks }: { readonly picks: number }): ReactNode {
  return (
    <div className="fy-ad" data-appearance-demo="">
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
            <span className="fy-ad__text">Quick fox</span>
            <em className="fy-ad__label">Label</em>
            <span className="fy-ad__button" data-appearance-demo-accent="" />
            <span className="fy-ad__input" />
            <span className="fy-ad__card" />
            <span className="fy-ad__toggle" />
            <span className="fy-ad__row" />
            <span className="fy-ad__row" />
          </div>
        </div>
      </div>
    </div>
  );
}
