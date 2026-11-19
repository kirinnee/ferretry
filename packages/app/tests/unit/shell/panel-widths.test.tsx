import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  clampWidth,
  fitWidthsToViewport,
  panelWidths,
  PANEL_RANGES,
  useApplyPanelWidths,
} from '../../../src/shell/panel-widths.ts';
import { APP_STORAGE } from '../../../src/storage/names.ts';
import { ResizeHandle } from '../../../src/ui/resize-handle.tsx';
import { interact, type Mounted, mount, must, pressKey } from '../../support/dom.ts';
import { bootApp } from './frame-fixtures.tsx';

/**
 * RESIZABLE PANELS (r10 S3): a grab strip on the drawer, the side column and the settings list; a pointer drag, the keyboard
 * and a double-click move it inside its range; the width is kept per device and put back on reload; a phone has no handles.
 */

let view: Mounted | undefined;
const root = document.documentElement;
const vars = ['--fy-w-side', '--fy-w-drawer', '--fy-w-settings-nav'] as const;

const reset = (): void => {
  panelWidths.forget();
  for (const name of vars) root.style.removeProperty(name);
  window.localStorage.removeItem(APP_STORAGE.panelWidths);
};
beforeEach(reset);
afterEach(async () => {
  await view?.unmount();
  view = undefined;
  reset();
});

const handle = (scope: ParentNode, panel: string): HTMLElement =>
  must(scope.querySelector<HTMLElement>(`[data-resize-handle="${panel}"]`), `the ${panel} handle`);
const pointer = (target: HTMLElement, type: string, clientX: number): void => {
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientX }));
};
/** Runs `body` in a window of this inner width (the fit to the window reads it), then puts the real width back. */
async function inWindow(width: number, body: () => Promise<void>): Promise<void> {
  const before = window.innerWidth;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  try {
    await body();
  } finally {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: before });
  }
}
const stored = (): unknown => JSON.parse(window.localStorage.getItem(APP_STORAGE.panelWidths) ?? 'null');

/** Mounts a handle with the applier the frame mounts once, so the root variable follows. */
function Harness({ edge }: { readonly edge: 'start' | 'end' }) {
  useApplyPanelWidths();
  return <ResizeHandle panel="drawer" edge={edge} label="side bar" />;
}

describe('clampWidth', () => {
  test('holds each panel inside the plan range and reads a non-number as the minimum', () => {
    expect(clampWidth('side', 10)).toBe(280);
    expect(clampWidth('side', 9000)).toBe(640);
    expect(clampWidth('drawer', 300.4)).toBe(300);
    expect(clampWidth('drawer', 9000)).toBe(400);
    expect(clampWidth('settings-nav', 0)).toBe(180);
    expect(clampWidth('settings-nav', 321)).toBe(320);
    expect(clampWidth('drawer', Number.NaN)).toBe(PANEL_RANGES.drawer.min);
  });
});

describe('the grab strip', () => {
  test('a drag changes the CSS variable, is clamped, and is stored only when it ends', async () => {
    view = await mount(<Harness edge="end" />);
    const strip = handle(view.container, 'drawer');
    await interact(() => pointer(strip, 'pointerdown', 100));
    expect(root.getAttribute('data-panel-resizing')).toBe('drawer');
    await interact(() => pointer(strip, 'pointermove', 180)); // starts from the range minimum (no layout here): 220 + 80
    expect(root.style.getPropertyValue('--fy-w-drawer')).toBe('300px');
    expect(stored()).toBeNull();
    await interact(() => pointer(strip, 'pointermove', 5000));
    expect(root.style.getPropertyValue('--fy-w-drawer')).toBe('400px');
    await interact(() => pointer(strip, 'pointerup', 5000));
    expect(root.hasAttribute('data-panel-resizing')).toBe(false);
    expect(stored()).toEqual({ format: 1, value: { drawer: 400 } });
    expect(strip.getAttribute('aria-valuenow')).toBe('400');
  });

  test('a panel on the right of the page grows when its strip is dragged left', async () => {
    view = await mount(<Harness edge="start" />);
    const strip = handle(view.container, 'drawer');
    await interact(() => pointer(strip, 'pointerdown', 500));
    await interact(() => pointer(strip, 'pointermove', 460));
    await interact(() => pointer(strip, 'pointerup', 460));
    expect(root.style.getPropertyValue('--fy-w-drawer')).toBe('260px');
  });

  test('the keyboard: arrows move 16px, Home puts the panel back, a double-click does too', async () => {
    view = await mount(<Harness edge="end" />);
    const strip = handle(view.container, 'drawer');
    expect(strip.getAttribute('role')).toBe('separator');
    expect(strip.tabIndex).toBe(0);
    await interact(() => pressKey(strip, 'ArrowRight'));
    expect(root.style.getPropertyValue('--fy-w-drawer')).toBe('236px');
    await interact(() => pressKey(strip, 'ArrowRight'));
    await interact(() => pressKey(strip, 'ArrowLeft'));
    expect(root.style.getPropertyValue('--fy-w-drawer')).toBe('236px');
    expect(stored()).toEqual({ format: 1, value: { drawer: 236 } });
    await interact(() => pressKey(strip, 'Home'));
    expect(root.style.getPropertyValue('--fy-w-drawer')).toBe('');
    expect(stored()).toBeNull();
    await interact(() => pressKey(strip, 'ArrowRight'));
    expect(root.style.getPropertyValue('--fy-w-drawer')).toBe('236px');
    await interact(() => strip.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(root.style.getPropertyValue('--fy-w-drawer')).toBe('');
  });

  test('on the right of the page the arrows turn the other way (←  widens)', async () => {
    view = await mount(<Harness edge="start" />);
    await interact(() => pressKey(handle(view?.container ?? document.body, 'drawer'), 'ArrowLeft'));
    expect(root.style.getPropertyValue('--fy-w-drawer')).toBe('236px');
  });
});

describe('in the app', () => {
  test('the drawer and the settings list each carry a handle, and a stored width is on the page at once (clamped)', async () => {
    window.localStorage.setItem(
      APP_STORAGE.panelWidths,
      JSON.stringify({ format: 1, value: { drawer: 333, 'settings-nav': 9999 } }),
    );
    await inWindow(1280, async () => {
      const app = await bootApp({ surfaces: [], machines: ['d1'], path: '/d/d1/settings' });
      view = app.view;
      expect(handle(app.view.container, 'drawer').getAttribute('aria-valuenow')).toBe('333');
      expect(handle(app.view.container, 'settings-nav').getAttribute('aria-valuenow')).toBe('320');
      expect(root.style.getPropertyValue('--fy-w-drawer')).toBe('333px');
      expect(root.style.getPropertyValue('--fy-w-settings-nav')).toBe('320px');
      expect(root.style.getPropertyValue('--fy-w-side')).toBe('');
    });
  });

  test('a value another page wrote that is not a width is ignored', async () => {
    window.localStorage.setItem(APP_STORAGE.panelWidths, JSON.stringify({ format: 1, value: { drawer: 'wide' } }));
    const app = await bootApp({ surfaces: [], machines: ['d1'], path: '/d/d1/settings' });
    view = app.view;
    expect(root.style.getPropertyValue('--fy-w-drawer')).toBe('');
  });

  test('a collapsed rail has no handle', async () => {
    window.localStorage.setItem(APP_STORAGE.drawer, JSON.stringify({ format: 1, value: { collapsed: true } }));
    const app = await bootApp({ surfaces: [], machines: ['d1'], path: '/d/d1' });
    view = app.view;
    expect(app.view.container.querySelector('.fy-drawer--rail')).not.toBeNull();
    expect(app.view.container.querySelector('[data-resize-handle]')).toBeNull();
    window.localStorage.removeItem(APP_STORAGE.drawer);
  });

  test('a phone has no handles, on the settings page or with the menu open', async () => {
    const app = await bootApp({ surfaces: [], machines: ['d1'], path: '/d/d1/settings', viewport: 'phone' });
    view = app.view;
    expect(app.view.container.querySelector('[data-resize-handle]')).toBeNull();
    await interact(() =>
      must(
        app.view.container.querySelector<HTMLButtonElement>('[aria-label="Menu"], [data-menu-button]'),
        'the menu button',
      ).click(),
    );
    expect(app.view.container.querySelector('[data-resize-handle]')).toBeNull();
  });
});

describe('fitWidthsToViewport (the settings pane keeps room on a narrow window)', () => {
  test('a roomy window leaves every width alone', () => {
    const saved = { drawer: 400, 'settings-nav': 320 } as const;
    expect(fitWidthsToViewport(saved, 1280)).toBe(saved);
    expect(fitWidthsToViewport({}, 768)).toEqual({});
  });

  test('768px: both saved widths shrink toward their minimums so the pane keeps its room', () => {
    const fitted = fitWidthsToViewport({ drawer: 400, 'settings-nav': 320 }, 768);
    expect(fitted).toEqual({ drawer: PANEL_RANGES.drawer.min, 'settings-nav': PANEL_RANGES['settings-nav'].min });
  });

  test('a partial squeeze shrinks each saved panel in proportion to how far it is above its minimum', () => {
    // 900px: budget 900 - 56 - 320 = 524; 400 + 320 = 720 → 196 over; room 180 + 140 = 320 → share 0.6125.
    const fitted = fitWidthsToViewport({ drawer: 400, 'settings-nav': 320 }, 900);
    expect(fitted.drawer).toBe(290);
    expect(fitted['settings-nav']).toBe(234);
    expect(400 - (fitted.drawer ?? 0) + (320 - (fitted['settings-nav'] ?? 0))).toBe(196);
  });

  test('an unsaved panel counts at its stylesheet width and is never given a value', () => {
    const fitted = fitWidthsToViewport({ drawer: 400 }, 768);
    expect(fitted).toEqual({ drawer: PANEL_RANGES.drawer.min });
    expect('settings-nav' in fitted).toBe(false);
  });

  test('the fitted value is what the page gets, and the stored one is untouched', async () => {
    await inWindow(768, async () => {
      panelWidths.set('drawer', 400);
      panelWidths.set('settings-nav', 320);
      view = await mount(<Harness edge="end" />);
      expect(root.style.getPropertyValue('--fy-w-drawer')).toBe('220px');
      expect(root.style.getPropertyValue('--fy-w-settings-nav')).toBe('180px');
      expect(stored()).toEqual({ format: 1, value: { drawer: 400, 'settings-nav': 320 } });
    });
  });
});
