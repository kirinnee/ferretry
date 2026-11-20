/**
 * The browser entry for the 300 ms wait gate on the folder explorer's "Reading your home folder…" status, over the REAL
 * `FolderExplorer` and the real stylesheet, every frame sampled.
 *
 *   ?theme=<family>-<mode>   ?ms=<n>   the folder read answers after n ms
 *
 * Leaves `window.__loader` = `{ firstVisible, lastVisible, frames }` (ms since the wait began; null = never visible).
 * "Visible" is the status in the DOM whose computed opacity, and every ancestor's, is above zero.
 */

import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FolderExplorer } from '../../../../app/features/folder-explorer/folder-explorer.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const ms = Number(params.get('ms') ?? '250');

function Scene() {
  const [waiting, setWaiting] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setWaiting(false), ms);
    return () => clearTimeout(timer);
  }, []);
  return waiting ? (
    <FolderExplorer
      error={null}
      listing={null}
      loading
      onMakeFolder={async () => null}
      onOpen={() => undefined}
      onShowHiddenChange={() => undefined}
      onViewChange={() => undefined}
      showHidden={false}
      view="list"
    />
  ) : (
    <p data-done="">Done</p>
  );
}

const LOADER = '[data-explorer-state="loading"] [role="status"]';

interface Sample {
  firstVisible: number | null;
  lastVisible: number | null;
  frames: number;
}
const sample: Sample = { firstVisible: null, lastVisible: null, frames: 0 };
(window as unknown as { __loader: Sample }).__loader = sample;

const began = performance.now();
const tick = (): void => {
  const at = performance.now() - began;
  sample.frames += 1;
  const seen = [...document.querySelectorAll<HTMLElement>(LOADER)].some(element => {
    for (let node: HTMLElement | null = element; node !== null; node = node.parentElement)
      if (Number(getComputedStyle(node).opacity) <= 0.01) return false;
    return true;
  });
  if (seen) {
    sample.firstVisible ??= at;
    sample.lastVisible = at;
  }
  if (at < ms + 1_500) requestAnimationFrame(tick);
};
requestAnimationFrame(tick);

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <div className="p-4">
      <Scene />
    </div>,
  );
