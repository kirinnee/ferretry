/**
 * THE TWO DEMOS of the layout step: a mini window drawn with divs (`layout-step.css`), one per answer. The part the
 * answer changes (the dock of places at the side bar's foot; the rows' spacing) moves once when its card becomes the chosen
 * one, and the picture is decorative (`aria-hidden` by the card that holds it).
 */

const NAV_ITEMS = [0, 1, 2, 3] as const;
const ROW_IDS = ['a', 'b', 'c', 'd', 'e', 'f'] as const;

export function NavDemo({ labels }: { readonly labels: string }) {
  return (
    <div className="fy-lstep-demo" data-demo="nav" data-labels={labels}>
      <div className="fy-lstep-demo__drawer">
        <div className="fy-lstep-demo__dock" data-moves="">
          {NAV_ITEMS.map(index => (
            <span key={index} data-on={index === 0 ? '' : undefined} />
          ))}
        </div>
      </div>
      <div className="fy-lstep-demo__body">
        <div className="fy-lstep-demo__page">
          {ROW_IDS.slice(0, 3).map(id => (
            <span key={id} className="fy-lstep-demo__row" />
          ))}
        </div>
      </div>
    </div>
  );
}

export function DensityDemo({ density }: { readonly density: string }) {
  const rows = density === 'compact' ? ROW_IDS : ROW_IDS.slice(0, 4);
  return (
    <div className="fy-lstep-demo" data-demo="density" data-density={density}>
      <div className="fy-lstep-demo__body">
        <div className="fy-lstep-demo__page" data-moves="">
          {rows.map(id => (
            <span key={id} className="fy-lstep-demo__row" />
          ))}
        </div>
      </div>
    </div>
  );
}
