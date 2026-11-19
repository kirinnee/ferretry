/**
 * THE MINI APP a layout preview draws: a window (or a phone) with the shell's left drawer (or, on a phone, its menu
 * button), a few list rows, perhaps a second column, perhaps a bar of places under the page. Divs and theme tokens only
 * (`previews.css`). It draws what the shell draws today and nothing it does not (`scene.ts`).
 */
import type { MiniShellState } from './scene.ts';

const ITEMS = [0, 1, 2, 3] as const;
const ROW_IDS = ['a', 'b', 'c', 'd', 'e', 'f', 'g'] as const;

function Item({
  index,
  labelled,
  iconed,
}: {
  readonly index: number;
  readonly labelled: boolean;
  readonly iconed: boolean;
}) {
  return (
    <span className="fy-ls-item" data-on={index === 0 ? '' : undefined}>
      {iconed ? <span className="fy-ls-ico" /> : null}
      {labelled ? <span className="fy-ls-lbl" /> : null}
    </span>
  );
}

/** The left drawer: a slim rail of icons, or open with an icon and a name on every row. */
function Drawer({ form, lit }: { readonly form: 'rail' | 'open'; readonly lit: boolean }) {
  return (
    <div className="fy-ls-nav fy-ls-drawer" data-form={form} data-lit={lit ? '' : undefined}>
      {ITEMS.map(index => (
        <Item key={index} index={index} iconed labelled={form === 'open'} />
      ))}
    </div>
  );
}

/** The bar of places under the page: names only, as the shell draws it. */
function BottomBar({ lit }: { readonly lit: boolean }) {
  return (
    <div className="fy-ls-nav fy-ls-bottom" data-lit={lit ? '' : undefined}>
      {ITEMS.map(index => (
        <Item key={index} index={index} iconed={false} labelled />
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
  // A narrow frame (and a phone) has no drawer on screen: it is shut behind a menu button.
  const drawer = device === 'wide' ? state.drawer : 'none';
  const navLit = state.lit === 'nav';
  return (
    <div className="fy-ls-frame" data-device={device}>
      {drawer === 'none' ? null : <Drawer form={drawer} lit={navLit && !state.bottom} />}
      <div className="fy-ls-body">
        {drawer === 'none' ? <span className="fy-ls-menu" data-lit={navLit && !state.bottom ? '' : undefined} /> : null}
        <div className="fy-ls-page">
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
        {state.bottom ? <BottomBar lit={navLit} /> : null}
      </div>
    </div>
  );
}

/** Four list rows at a comfortable density, seven at a compact one: the room each takes is the whole point of that key. */
const rowsFor = (state: MiniShellState): number => (state.lit === 'rows' && state.density === 'compact' ? 7 : 4);

export function MiniShell({ state }: { readonly state: MiniShellState }) {
  return (
    <div className="fy-ls-scene" data-pair={state.pair ? '' : undefined}>
      <Frame state={state} device={state.device} column={state.column} rows={rowsFor(state)} />
      {state.pair ? <Frame state={state} device="narrow" column={state.narrowColumn} rows={rowsFor(state)} /> : null}
    </div>
  );
}
