/**
 * THE DEMO of the layout step: ONE mini window, drawn with divs (`layout-step.css`), that shows both answers at once:
 * the places at the side bar's foot (small squares for icons, wide bars in two columns for words) and the page's row
 * spacing (comfortable or compact). The part an answer changes moves once, when that answer is picked, and rests on its
 * final picture otherwise. The page puts it in the frame's demo column (`StepDemo`), where it is decorative.
 */

const NAV_ITEMS = [0, 1, 2, 3] as const;
const ROW_IDS = ['a', 'b', 'c', 'd', 'e', 'f', 'g'] as const;

export interface LayoutDemoProps {
  readonly labels: string;
  readonly density: string;
  /** The question whose answer was just picked (and how many picks so far): that part plays once. Absent: all at rest. */
  readonly moved?: { readonly question: 'nav' | 'density'; readonly count: number } | undefined;
}

export function LayoutDemo({ labels, density, moved }: LayoutDemoProps) {
  const rows = density === 'compact' ? ROW_IDS : ROW_IDS.slice(0, 5);
  return (
    <div className="fy-lstep-demo" data-layout-demo="" data-labels={labels} data-density={density}>
      <div className="fy-lstep-demo__drawer">
        <div
          key={moved?.question === 'nav' ? `nav-${moved.count}` : 'nav'}
          className="fy-lstep-demo__dock"
          data-moves={moved?.question === 'nav' ? '' : undefined}
        >
          {NAV_ITEMS.map(index => (
            <span key={index} data-on={index === 0 ? '' : undefined} />
          ))}
        </div>
      </div>
      <div className="fy-lstep-demo__body">
        <div
          key={moved?.question === 'density' ? `density-${moved.count}` : 'density'}
          className="fy-lstep-demo__page"
          data-moves={moved?.question === 'density' ? '' : undefined}
        >
          {rows.map(id => (
            <span key={id} className="fy-lstep-demo__row" />
          ))}
        </div>
      </div>
    </div>
  );
}
