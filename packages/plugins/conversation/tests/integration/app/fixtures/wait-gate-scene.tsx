/**
 * The browser entry for the 300 ms wait gate on Conversation's two read statuses, over the REAL components and the real
 * stylesheet, every frame sampled: the composer's "Searching…" suggestion row and the current-session search's indexing
 * spinner and line.
 *
 *   ?theme=<family>-<mode>   ?scene=popover|search&ms=<n>   the read answers after n ms
 *
 * Leaves `window.__loader` = `{ firstVisible, lastVisible, frames }` (ms since the wait began; null = never visible).
 * "Visible" is a status element in the DOM whose computed opacity, and every ancestor's, is above zero.
 */

import { useEffect, useRef, useState } from 'react';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { createRoot } from 'react-dom/client';
import {
  ComposerAutocompletePopover,
  type ComposerAutocompleteSurface,
} from '../../../../app/composer/composer-autocomplete-popover.tsx';
import { ConversationClientProvider } from '../../../../app/client.ts';
import {
  SessionSearchControl,
  SessionSearchProvider,
  type FerretSearchScope,
} from '../../../../app/search/session-search.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const scene = params.get('scene') ?? 'popover';
const ms = Number(params.get('ms') ?? '250');

const SURFACE: ComposerAutocompleteSurface = {
  open: true,
  status: 'loading',
  provider: null,
  match: null,
  candidates: [],
  activeIndex: -1,
  contextLabel: 'Files',
  listboxId: 'wait-gate-listbox',
  accept: () => undefined,
};

/** The read's answer: one suggestion (an empty answer would draw its own "Nothing matches yet" status row). */
const ANSWERED: ComposerAutocompleteSurface = {
  ...SURFACE,
  status: 'ready',
  activeIndex: 0,
  candidates: [
    { id: 'command-compact', kind: 'command', label: 'compact', detail: 'Free up context', replacement: '/compact' },
  ],
};

function Popover() {
  const [waiting, setWaiting] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setWaiting(false), ms);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div style={{ position: 'relative', height: 260, width: 360 }}>
      <ComposerAutocompletePopover surface={waiting ? SURFACE : ANSWERED} />
    </div>
  );
}

const SCOPE: FerretSearchScope = { daemon: 'wait-daemon', ferret: 'ferret-a' };
/** A hand-rolled client (the shared fake pulls Node modules into the browser bundle): its one read answers after `ms`. */
const client = {
  call: () =>
    new Promise(resolve =>
      setTimeout(
        () => resolve({ v: 1, sessionId: 'ferret-a', root: '/work/a', files: [], coverage: 'complete', skipped: [] }),
        ms,
      ),
    ),
  subscribe: () => () => undefined,
} as unknown as PluginClient;

function Search() {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.querySelector('input')?.focus();
  }, []);
  return (
    <ConversationClientProvider client={client}>
      <SessionSearchProvider cards={{ state: 'ready', error: null, cards: [] }} scope={SCOPE}>
        <div ref={box} style={{ position: 'relative', width: 360 }}>
          <SessionSearchControl />
        </div>
      </SessionSearchProvider>
    </ConversationClientProvider>
  );
}

const LOADERS: Record<string, string> = {
  popover: '.fy-ac-state[role="status"]',
  search: '[data-search-indexing], [data-session-search-popup] [role="status"]',
};
const LOADER = LOADERS[scene] ?? LOADERS.popover;

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
  const seen = [...document.querySelectorAll<HTMLElement>(LOADER as string)].some(element => {
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
if (root !== null) createRoot(root).render(<div className="p-4">{scene === 'search' ? <Search /> : <Popover />}</div>);
