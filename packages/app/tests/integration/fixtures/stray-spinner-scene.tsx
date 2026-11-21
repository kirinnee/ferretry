/**
 * The browser entry for r11 T3: real app sites that used to draw their own lucide `animate-spin` icon, mounted with
 * their real components and the real stylesheet. (The plugin-owned sites are held by their own unit tests: an app test
 * may not import another package's source.)
 *
 *   ?theme=<family>-<mode>
 *   site `form`   `FormFoot` submitting (a button busy mark: a wait, held for the threshold)
 *   site `locate` `PendingLocationChip` locating (a status line: a wait, held for the threshold)
 *   site `run`    `<Spinner size />` as a running activity (a CI job mark, a running tool: immediate)
 *
 * `window.__strays` answers what a person would see: how many shared spinners, how many `animate-spin` icons, and for
 * each site whether it is painted (own and ancestor opacity above zero) right now.
 */
import { createRoot } from 'react-dom/client';
import { PendingLocationChip } from '../../../src/shared/location-chip.tsx';
import { FormFoot, Spinner } from '../../../src/ui/index.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const painted = (element: Element | null): boolean => {
  if (element === null) return false;
  for (let node: Element | null = element; node !== null; node = node.parentElement)
    if (Number(getComputedStyle(node).opacity) <= 0.01) return false;
  return true;
};

(window as unknown as { __strays: () => unknown }).__strays = () => ({
  spinners: document.querySelectorAll('.fy-spinner').length,
  strays: document.querySelectorAll('svg.animate-spin, .animate-spin').length,
  sites: ['form', 'locate', 'run'].map(site => {
    const mark = document.querySelector(`[data-site="${site}"] .fy-spinner`);
    const box = mark?.getBoundingClientRect();
    return { site, present: mark !== null, painted: painted(mark), width: box?.width ?? 0, height: box?.height ?? 0 };
  }),
});

const root = document.getElementById('root');
if (root !== null)
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
      <div data-site="run">
        <Spinner size={16} />
      </div>
    </main>,
  );
