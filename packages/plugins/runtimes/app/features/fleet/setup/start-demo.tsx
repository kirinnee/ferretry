/**
 * The scene in the Start page's demo column. Decorative (the demo column is `aria-hidden`; the cards' own words say the
 * same thing). It follows the chosen card, and replays when the choice changes (the key):
 *
 *   fresh: one machine, its setup rows ticking off one after another: "walk through each step".
 *   clone: another machine on the left, its rows flying across to this machine on the right: "copy the settings".
 *
 * The words are neutral (no tool or account names). At rest, and with motion off, the finished picture shows, so the
 * scene is never blank (`start-demo.css`).
 */

import { ArrowRight, Check } from 'lucide-react';
import type { CSSProperties } from 'react';
import './start-demo.css';

const ROWS = ['Warden', 'Voice', 'Runtimes'] as const;

export type StartMode = 'fresh' | 'clone';

function Rows({ ticked }: { readonly ticked: boolean }) {
  return (
    <ul className="fy-ssd__rows">
      {ROWS.map((row, at) => (
        <li key={row} className="fy-ssd__row" style={{ '--fy-ssd-at': at } as CSSProperties}>
          <span className="fy-ssd__tick">{ticked ? <Check size={12} strokeWidth={3} /> : null}</span>
          {row}
        </li>
      ))}
    </ul>
  );
}

export function StartDemo({ mode }: { readonly mode: StartMode }) {
  return (
    <div className="fy-ssd" data-start-demo="" data-start-mode={mode} key={mode}>
      {mode === 'clone' ? (
        <>
          <div className="fy-ssd__machine fy-ssd__machine--from">
            <span className="fy-ssd__name">Other machine</span>
            <Rows ticked />
          </div>
          <ArrowRight className="fy-ssd__arrow" size={22} />
        </>
      ) : null}
      <div className="fy-ssd__machine fy-ssd__machine--here">
        <span className="fy-ssd__name">This machine</span>
        <Rows ticked />
      </div>
    </div>
  );
}
