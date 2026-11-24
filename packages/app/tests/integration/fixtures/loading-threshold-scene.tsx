/**
 * The browser entry for the 300 ms loader threshold, over the REAL loaders and the real stylesheet.
 *
 *   ?theme=<family>-<mode>   ?motion=reduced  sets Settings › Motion to Reduced
 *   ?scene=page|held|bar|barpage|cache|spinner|sheet&ms=<n>   starts a wait at mount and ends it after n ms (page: Loading kind="page"
 *                                          mounted straight off the read; held: the same under useHeldLoading; bar: useBackgroundLoad + the one bar; cache: the
 *                                          "Updating…" pill; spinner: <Spinner wait />; sheet: the page wait inside the real BottomSheet, whose
 *                                          transform makes a position:fixed descendant relative to the sheet, not the viewport)
 *
 * It samples every animation frame from the instant the wait starts and leaves `window.__loader` =
 * `{ firstVisible, lastVisible, frames }` (ms since the wait began; null = a loader pixel was never visible). "Visible" is
 * a loader element that is in the DOM AND has a computed opacity above zero, which is what a person can see.
 */

import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  CacheUpdating,
  Loading,
  LoadingBarHost,
  Spinner,
  useBackgroundLoad,
  useHeldLoading,
  BottomSheet,
} from '../../../src/ui/index.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
if (params.get('motion') === 'reduced') document.documentElement.dataset.motion = 'reduced';

const scene = params.get('scene') ?? 'page';
const ms = Number(params.get('ms') ?? '250');

/** True from mount until `ms` later: the fake read. */
function useFakeRead(): boolean {
  const [waiting, setWaiting] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setWaiting(false), ms);
    return () => clearTimeout(timer);
  }, []);
  return waiting;
}

/** The ACTUAL read path of ~110 call sites: the owner mounts `Loading` straight off its read state, no hook between. */
const PageWait = () => (useFakeRead() ? <Loading kind="page" label="Reading the thing…" /> : <p data-done="">Done</p>);

/** The shell's own path (`PluginView`): the same loader under `useHeldLoading`. */
const HeldWait = () => {
  const held = useHeldLoading(useFakeRead());
  return held ? <Loading kind="page" label="Reading the thing…" /> : <p data-done="">Done</p>;
};

const BarWait = () => {
  useBackgroundLoad(useFakeRead());
  return <LoadingBarHost />;
};

/** A background read whose page loader mounts 400 ms in, while the bar is already drawn: the one-indicator rule (L203). */
const BarThenPage = () => {
  const waiting = useFakeRead();
  useBackgroundLoad(waiting);
  const [page, setPage] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setPage(true), 400);
    return () => clearTimeout(timer);
  }, []);
  return (
    <>
      <LoadingBarHost />
      {page && waiting ? <Loading kind="page" label="Reading the thing…" /> : null}
    </>
  );
};

const CacheWait = () => (useFakeRead() ? <CacheUpdating /> : <p data-done="">Done</p>);

const SpinnerWait = () => (useFakeRead() ? <Spinner size={20} wait /> : <p data-done="">Done</p>);

/** A transformed ancestor: the real sheet (translateY) holding a page wait. */
const SheetWait = () => (
  <BottomSheet id="loader-sheet" open onClose={() => undefined} ariaLabel="A sheet that is reading" closeLabel="Close">
    {/* Tall enough for the loader AND its answer, as a real sheet's content is: the sheet must not resize when the read ends. */}
    <div className="p-4" style={{ minHeight: 400 }}>
      <PageWait />
    </div>
  </BottomSheet>
);

const SCENES = {
  page: PageWait,
  held: HeldWait,
  bar: BarWait,
  barpage: BarThenPage,
  cache: CacheWait,
  spinner: SpinnerWait,
  sheet: SheetWait,
} as const;
const Scene = SCENES[scene as keyof typeof SCENES] ?? PageWait;

const LOADER = '[data-loading], .fy-loading-bar, [data-cache-updating], .fy-spinner';

interface Sample {
  firstVisible: number | null;
  lastVisible: number | null;
  frames: number;
  /** The most leftover copies of a loader any single frame held: always 0 (nothing is left over what replaced a loader). */
  ghosts: number;
  /** Frames in which the top bar AND a page loader were both painted: always 0 (one indicator at a time). */
  both: number;
}
const sample: Sample = {
  firstVisible: null,
  lastVisible: null,
  frames: 0,
  ghosts: 0,
  both: 0,
};
(window as unknown as { __loader: Sample }).__loader = sample;

const began = performance.now();
const tick = (): void => {
  const at = performance.now() - began;
  sample.frames += 1;
  sample.ghosts = Math.max(sample.ghosts, document.querySelectorAll('[data-loading-ghost], .fy-loading-ghost').length);
  const painted = (element: Element): boolean => {
    for (let node: Element | null = element; node !== null; node = node.parentElement)
      if (Number(getComputedStyle(node).opacity) <= 0.01) return false;
    return true;
  };
  if (
    [...document.querySelectorAll('[data-loading="bar"]')].some(painted) &&
    [...document.querySelectorAll('[data-loading="page"]')].some(painted)
  )
    sample.both += 1;
  const seen = [...document.querySelectorAll<HTMLElement>(LOADER)].some(element => {
    // The element AND every ancestor up to the root must be painted: the gate may sit on a wrapper.
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
    <div className="p-4" style={{ minHeight: 200 }}>
      <Scene />
    </div>,
  );
