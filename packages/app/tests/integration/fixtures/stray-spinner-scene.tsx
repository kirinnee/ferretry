/**
 * The browser entry for r11 T3: real app sites that used to draw their own lucide `animate-spin` icon, mounted with
 * their real components and the real stylesheet. (The plugin-owned sites are held by their own browser tests: an app
 * test may not import another package's source; the running CI mark is held by pulls' `ci-run.visual.test.ts`.)
 *
 *   ?theme=<family>-<mode>
 *   site `form`   `FormFoot` submitting (a button busy mark: a wait, held for the threshold)
 *   site `locate` `PendingLocationChip` locating (a status line: a wait, held for the threshold)
 *
 * `window.__strays` answers what a person would see: how many shared spinners, how many `animate-spin` icons, and for
 * each site whether it is painted (own and ancestor opacity above zero) right now.
 *
 * `window.__firstPaint` is the 300 ms measure: a frame loop that starts at the mount and records, for each site, the
 * milliseconds from the mount to the first frame in which the site was painted (`null` until then).
 */
import { createRoot } from 'react-dom/client';
import { PendingLocationChip } from '../../../src/shared/location-chip.tsx';
import { FormFoot } from '../../../src/ui/index.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const SITES = ['form', 'locate'] as const;
const markOf = (site: string): Element | null => document.querySelector(`[data-site="${site}"] .fy-spinner`);

const painted = (element: Element | null): boolean => {
  if (element === null) return false;
  for (let node: Element | null = element; node !== null; node = node.parentElement)
    if (Number(getComputedStyle(node).opacity) <= 0.01) return false;
  return true;
};

(window as unknown as { __strays: () => unknown }).__strays = () => ({
  spinners: document.querySelectorAll('.fy-spinner').length,
  strays: document.querySelectorAll('svg.animate-spin, .animate-spin').length,
  sites: SITES.map(site => {
    const mark = markOf(site);
    const box = mark?.getBoundingClientRect();
    return { site, present: mark !== null, painted: painted(mark), width: box?.width ?? 0, height: box?.height ?? 0 };
  }),
});

const firstPaint: Record<string, number | null> = Object.fromEntries(SITES.map(site => [site, null]));
(window as unknown as { __firstPaint: () => unknown }).__firstPaint = () => ({ ...firstPaint });

const root = document.getElementById('root');
if (root !== null) {
  const mounted = performance.now();
  const watch = (): void => {
    for (const site of SITES)
      if (firstPaint[site] === null && painted(markOf(site))) firstPaint[site] = performance.now() - mounted;
    if (SITES.some(site => firstPaint[site] === null)) requestAnimationFrame(watch);
  };
  requestAnimationFrame(watch);
  createRoot(root).render(
    <main className="grid gap-4 p-6">
      <div data-site="form">
        <FormFoot onCancel={() => undefined} submitLabel="Save" submitting />
      </div>
      <div data-site="locate">
        <PendingLocationChip
          draft={{ kind: 'locating' }}
          onPlace={() => undefined}
          onRemove={() => undefined}
          onRetry={() => undefined}
        />
      </div>
    </main>,
  );
}
