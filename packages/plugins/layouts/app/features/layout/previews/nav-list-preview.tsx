/**
 * THE PREVIEW BESIDE A NAVIGATION LIST: five menu rows drawn from the real list (a name's length sets its bar), and one
 * loop that shows what a list is for — a row lifts (the one lit row), slides to a new place while the rows it passes
 * slide aside, and another dims as if hidden. The rows move on `transform` and `opacity` only, hung on the loop
 * `SettingPreview` owns (`--sp-loop`); the resting frame is the final order, so a still frame shows the answer.
 */
import { SettingPreview } from '@ferretry/app';
import './previews.css';

/** The bar widths a list of fewer names than rows falls back to, so a short list still draws five rows. */
const FALLBACK_WIDTHS = [62, 48, 70, 54, 40] as const;

/** A name's bar: longer names draw longer bars, within what fits beside the icon. */
const widthOf = (name: string | undefined, index: number): number =>
  name === undefined ? (FALLBACK_WIDTHS[index] ?? 50) : Math.min(78, 30 + name.length * 5);

/** The roles the five rows play: row 1 lifts to the 4th place, rows 2 and 3 move up to make room, row 4 is hidden. */
type Role = 'still' | 'lift' | 'shift' | 'hide';
const ROLES: readonly Role[] = ['still', 'lift', 'shift', 'shift', 'hide'];
/** Where the rows rest at the end of the loop (indexes of the starting order). */
const FINAL_ORDER = [0, 2, 3, 1, 4] as const;

function Scene({ items }: { readonly items: readonly string[] }) {
  return (
    <div className="fy-ls-scene fy-ls-scene--list">
      <div className="fy-ls-nlist">
        {FINAL_ORDER.map(start => (
          <span key={start} className="fy-ls-nrow" data-role={ROLES[start]}>
            <span className="fy-ls-ico" />
            <span className="fy-ls-lbl" style={{ width: `${widthOf(items[start], start)}%` }} />
          </span>
        ))}
      </div>
    </div>
  );
}

export function NavListPreview({ items, label }: { readonly items: readonly string[]; readonly label: string }) {
  return (
    <SettingPreview
      className="fy-ls fy-ls--own"
      label={label}
      value={items.join(',')}
      // Nothing is drawn before: this scene moves its own rows, so the cross-fade layer is switched off in the stylesheet.
      before={null}
      after={<Scene items={items} />}
    />
  );
}
