import { afterEach, describe, expect, test } from 'bun:test';
import { implementApp } from '@ferretry/kernel/manifest';
import { type ReactNode, use } from 'react';
import { provideToShell } from '../../../src/connect/provides.ts';
import { storedOverrides } from '../../../src/layout/device-layout.ts';
import type { LayoutOverrides } from '../../../src/layout/layout.ts';
import { APP_STORAGE } from '../../../src/storage/names.ts';
import { memoryStore, writeRecord } from '../../../src/storage/records.ts';
import { PanelSlot } from '../../../src/shell/views.tsx';
import { interact, type Mounted } from '../../support/dom.ts';
import { bootApp, entryOf, manifestOf, settle } from './frame-fixtures.tsx';

/**
 * ONE LOADER, NEVER A STACK (A555 r7). While a daemon has not said what it offers, every panel and tab of a page used to
 * print "Checking what this daemon offers…" on its own, so a page of nine sections showed nine. Now the page-sized view
 * draws ONE loader, panels draw none of their own, and the shell's one top bar stands for the rest.
 */

const PANELS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const manifest = manifestOf('crowd', {
  ui: {
    screens: [{ id: 'page', path: 'page', nav: { label: 'Page', order: 1 } }],
    panels: PANELS.map((id, order) => ({ id, slot: 'side', order })),
  },
});
const crowd = entryOf(
  manifest,
  provideToShell(
    implementApp(manifest, {
      build: () => ({
        screens: {
          page: (): ReactNode => (
            <section data-testid="page">
              <PanelSlot daemon="d1" slot="side" />
            </section>
          ),
        },
        panels: Object.fromEntries(PANELS.map(id => [id, () => <p data-testid={`panel-${id}`}>{id}</p>])),
      }),
    }),
    {},
  ),
);

// ─── one readiness gate per slot: a panel still arriving holds the others back ───
let release: () => void = () => {};
const arrival = new Promise<void>(resolve => {
  release = resolve;
});
const gateManifest = manifestOf('holdback', {
  ui: {
    screens: [{ id: 'page', path: 'page', nav: { label: 'Page', order: 1 } }],
    panels: [
      { id: 'quick', slot: 'side', order: 1 },
      { id: 'late', slot: 'side', order: 2 },
    ],
  },
});
const gate = entryOf(
  gateManifest,
  provideToShell(
    implementApp(gateManifest, {
      build: () => ({
        screens: {
          page: (): ReactNode => (
            <section data-testid="page">
              <PanelSlot daemon="d1" slot="side" />
            </section>
          ),
        },
        panels: {
          quick: () => <p data-testid="panel-quick">quick</p>,
          late: () => {
            use(arrival);
            return <p data-testid="panel-late">late</p>;
          },
        },
      }),
    }),
    {},
  ),
);

const sideColumn = () => {
  const storage = memoryStore();
  writeRecord(
    storage,
    APP_STORAGE.layout,
    storedOverrides({
      side: { holds: 'panels' },
      panels: { 'ferret.side': [] },
      'composer.tools': [],
    } as LayoutOverrides),
  );
  return storage;
};

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});
const pause = (ms: number): Promise<void> => interact(() => new Promise(resolve => setTimeout(resolve, ms)));
const count = (selector: string): number => view?.container.querySelectorAll(selector).length ?? 0;
const text = (): string => view?.container.textContent ?? '';

describe('a slot draws once, together', () => {
  test('r7: a panel that is still arriving holds the ready one back; then both draw at the same time', async () => {
    const app = await bootApp({ surfaces: [gate], machines: ['d1'], path: '/d/d1/page', storage: sideColumn() });
    view = app.view;
    await settle();
    await pause(50);
    expect(count('[data-testid="panel-quick"]')).toBe(0);
    expect(count('[data-testid="panel-late"]')).toBe(0);
    release();
    await pause(700);
    await settle();
    expect(count('[data-testid="panel-quick"]')).toBeGreaterThanOrEqual(1);
    expect(count('[data-testid="panel-late"]')).toBeGreaterThanOrEqual(1);
  });
});

describe('while the daemon has not said what it offers', () => {
  test('r7: nine panels and the page are ONE loader and no sentence, then the content', async () => {
    let answer: (value: unknown) => void = () => {};
    const holdInventory = new Promise(resolve => {
      answer = resolve;
    });
    const app = await bootApp({
      surfaces: [crowd],
      machines: ['d1'],
      path: '/d/d1/page',
      storage: sideColumn(),
      holdInventory,
    });
    view = app.view;
    await settle();
    // The sentence is the page loader's label, said ONCE (it was said once per panel and tab: nine times).
    expect(count('[data-loading="page"]')).toBe(1);
    expect(text().split('Checking what this daemon offers').length - 1).toBe(1);
    expect(count('.fy-shell-line')).toBe(0);
    answer(undefined);
    await pause(700);
    await settle();
    expect(count('[data-loading="page"]')).toBe(0);
    expect(count('[data-testid="page"]')).toBe(1);
    for (const id of PANELS) expect(count(`[data-testid="panel-${id}"]`)).toBeGreaterThanOrEqual(1);
  });

  test('r7: a daemon that answers at once never paints a loader', async () => {
    const seen: number[] = [];
    const app = await bootApp({ surfaces: [crowd], machines: ['d1'], path: '/d/d1/page', storage: sideColumn() });
    view = app.view;
    const observer = new MutationObserver(() => seen.push(count('[data-loading]')));
    observer.observe(view.container, { childList: true, subtree: true });
    await settle();
    await pause(400);
    observer.disconnect();
    expect(count('[data-loading]')).toBe(0);
    expect(count('[data-testid="page"]')).toBe(1);
  });
});
