/**
 * The scene in the step's demo column: a ferret and the tools it gets, without nix and with it. Without nix it works with
 * the tools already on the machine; with nix it gets its own shell, built once. Neutral words, decorative (the demo
 * column is `aria-hidden`; the page's own words say the same thing). At rest, or with motion off, it shows the finished
 * picture so it is never blank (`shells-step.css`).
 */

export function ShellsDemo() {
  return (
    <div className="fy-shd" data-shells-demo="">
      <div className="fy-shd__row" data-without="">
        <span className="fy-shd__ferret">Ferret</span>
        <span className="fy-shd__arrow" aria-hidden="true">
          →
        </span>
        <span className="fy-shd__tools">This machine’s tools</span>
      </div>
      <div className="fy-shd__row fy-shd__row--with" data-with="">
        <span className="fy-shd__ferret">Ferret</span>
        <span className="fy-shd__arrow" aria-hidden="true">
          →
        </span>
        <span className="fy-shd__shell">Its own shell</span>
      </div>
    </div>
  );
}
