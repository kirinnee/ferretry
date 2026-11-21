/**
 * THE NEXT-SPINNER SAMPLER (r11-1c C3), an init script. Every time the footer Next's busy spinner (`[data-step-next] .fy-spinner`, the live one or the still copy that keeps
 * its minimum) was VISIBLE: its computed opacity (its `.fy-spinner-wait` gate when it has one) above 0. A mutation observer
 * stamps the start (so a 15 ms flash cannot fall between two frames); the end is decided by the frame loop, because the still
 * copy arrives a microtask after the live one leaves.
 */
export const NEXT_SPINNER_LOG = `
  window.__nextSpinner = [];
  let shownAt = -1;
  let fullAt = -1;
  const mark = () => document.querySelector('[data-step-next] .fy-spinner');
  const look = () => {
    const node = mark();
    if (node === null) return false;
    const opacity = Number.parseFloat(getComputedStyle(node.closest('.fy-spinner-wait') ?? node).opacity);
    const now = performance.now();
    if (opacity > 0 && shownAt < 0) shownAt = now;
    if (opacity >= 0.99 && fullAt < 0) fullAt = now;
    return true;
  };
  const frame = () => {
    if (!look() && shownAt >= 0) {
      const end = performance.now();
      window.__nextSpinner.push({ ms: end - shownAt, fullMs: fullAt < 0 ? 0 : end - fullAt });
      shownAt = -1;
      fullAt = -1;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  new MutationObserver(look).observe(document, { childList: true, subtree: true });
`;

/** What the sampler leaves on `window.__nextSpinner`: one entry per time the spinner was visible. */
export interface NextSpinnerRun {
  readonly ms: number;
  readonly fullMs: number;
}
