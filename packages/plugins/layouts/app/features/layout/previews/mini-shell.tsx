/**
 * THE MINI APP a layout preview draws: a window (or a phone) with a menu on one side, a few list rows, and perhaps a
 * second column. Divs and theme tokens only (`previews.css`); the geometry is flex, so the same markup is a left column,
 * a right column, a top row or a bottom row by one class.
 */
import type { MiniShellState } from './scene.ts';

const ITEMS = [0, 1, 2, 3] as const;
const ROW_IDS = ['a', 'b', 'c', 'd', 'e', 'f', 'g'] as const;

function Nav({ state }: { readonly state: MiniShellState }) {
  return (
    <div
      className="fy-ls-nav"
      data-side={state.side}
      data-style={state.style}
      data-lit={state.lit === 'nav' ? '' : undefined}
    >
      {ITEMS.map(index => (
        <span key={index} className="fy-ls-item" data-on={index === 0 ? '' : undefined}>
          <span className="fy-ls-ico" />
          <span className="fy-ls-lbl" />
        </span>
      ))}
    </div>
  );
}

function Frame({
  state,
  device,
  column,
  rows,
}: {
  readonly state: MiniShellState;
  readonly device: 'wide' | 'phone' | 'narrow';
  readonly column: boolean;
  readonly rows: number;
}) {
  return (
    <div className="fy-ls-frame" data-device={device} data-side={state.side}>
      <Nav state={state} />
      <div className="fy-ls-body">
        <div className="fy-ls-main" data-density={state.density} data-lit={state.lit === 'rows' ? '' : undefined}>
          {ROW_IDS.slice(0, rows).map(id => (
            <span key={id} className="fy-ls-row" />
          ))}
        </div>
        {column ? (
          <div className="fy-ls-col" data-lit={state.lit === 'column' ? '' : undefined}>
            <span />
            <span />
            <span />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Four list rows at a comfortable density, six at a compact one: the room each takes is the whole point of that key. */
const rowsFor = (state: MiniShellState): number => (state.lit === 'rows' && state.density === 'compact' ? 7 : 4);

export function MiniShell({ state }: { readonly state: MiniShellState }) {
  return (
    <div className="fy-ls-scene" data-pair={state.pair ? '' : undefined}>
      <Frame state={state} device={state.device} column={state.column} rows={rowsFor(state)} />
      {state.pair ? <Frame state={state} device="narrow" column={state.narrowColumn} rows={rowsFor(state)} /> : null}
    </div>
  );
}
