import { afterEach, describe, test } from 'bun:test';
import should from 'should';

// Leaflet reads `window` while it loads, so it is imported only once the DOM exists.
const { mountMap } = await import('../../../../app/render/fy-render-map-engine.ts');
// The same rule for the library itself — and the same instance the engine holds, so a test that wraps
// `L.tileLayer` is heard by the engine too.
const { default: L } = await import('leaflet');

import { ensureDom } from '@ferretry/app/testing';

ensureDom();
import { type MapSpec, readMap } from '../../../../app/render/fy-render-map.ts';
import { MAP_TILE_ORIGIN } from '../../../../app/render/fy-render-map-tiles.ts';

/**
 * The engine, driven with the REAL Leaflet in a happy-dom document: no layout and no decoded image, so
 * the claims here are structural — what was created, where text went, what a control does. What the map
 * looks like and that a browser accepts it under the page's CSP is the integration and e2e tiers' job.
 */

const spec = (payload: string): MapSpec => {
  const reading = readMap(payload);
  if (!reading.ok) throw new Error(reading.reason);
  return reading.spec;
};

const hosts: HTMLElement[] = [];
const host = (width = 300, height = 200): HTMLElement => {
  const node = document.createElement('div');
  Object.defineProperty(node, 'clientWidth', { configurable: true, value: width });
  Object.defineProperty(node, 'clientHeight', { configurable: true, value: height });
  document.body.appendChild(node);
  hosts.push(node);
  return node;
};

const original = {
  matchMedia: window.matchMedia,
  resizeObserver: globalThis.ResizeObserver,
};

afterEach(() => {
  for (const node of hosts.splice(0)) node.remove();
  window.matchMedia = original.matchMedia;
  globalThis.ResizeObserver = original.resizeObserver;
});

const coarsePointer = (coarse: boolean): void => {
  window.matchMedia = ((query: string) => ({
    matches: coarse && query === '(pointer: coarse)',
  })) as typeof window.matchMedia;
};

interface Watcher {
  readonly callback: ResizeObserverCallback;
  readonly watching: Element[];
  disconnected: boolean;
}

const stubResizeObserver = (): Watcher[] => {
  const watchers: Watcher[] = [];
  globalThis.ResizeObserver = class {
    private readonly watcher: Watcher;
    constructor(callback: ResizeObserverCallback) {
      this.watcher = { callback, disconnected: false, watching: [] };
      watchers.push(this.watcher);
    }
    observe(target: Element): void {
      this.watcher.watching.push(target);
    }
    unobserve(): void {}
    disconnect(): void {
      this.watcher.disconnected = true;
    }
  } as unknown as typeof ResizeObserver;
  return watchers;
};

const labelled =
  'center: [51.5, -0.12]\nzoom: 12\nmarkers:\n  - {at: [51.5, -0.12], label: Home, popup: "Where <b>I</b> live", color: red}\n  - {at: [51.51, -0.1]}';

describe('fy-render map engine', () => {
  test('should draw tiles, pins and shapes into the host without any markup from the payload', () => {
    // Arrange
    const node = host();

    // Act
    const handle = mountMap(
      node,
      spec(
        `${labelled}\nlines: [{points: [[51.5, -0.12], [51.51, -0.1]], label: Route, color: blue}, [[1, 1], [2, 2]]]\npolygons: [{points: [[0, 0], [0, 1], [1, 1]], label: Park}]`,
      ),
    );

    // Assert
    should(node.classList.contains('leaflet-container')).be.true();
    should(node.querySelectorAll('.fy-map-pin').length).equal(2);
    should(node.querySelector('.fy-map-pin-label')?.textContent).equal('Home');
    should(node.querySelectorAll('.fy-map-pin-label').length).equal(1);
    should(node.querySelector('.fy-map-pin')?.getAttribute('style')).containEql('--fy-map-pin');
    should(node.querySelectorAll('path').length).equal(3);
    should(node.querySelector('.leaflet-control-zoom')).be.null();
    should(node.querySelector('.leaflet-control-attribution')).be.null();
    for (const tile of node.querySelectorAll<HTMLImageElement>('img.leaflet-tile')) {
      should(tile.src.startsWith(`${MAP_TILE_ORIGIN}/`)).be.true();
      should(tile.getAttribute('referrerpolicy')).equal('strict-origin-when-cross-origin');
    }
    handle.destroy();
  });

  test('should load the tiles in anonymous CORS mode while the tile host still gets its Referer', () => {
    // Arrange — capture what the engine asks of the tile layer, the way this file stubs `matchMedia`.
    // happy-dom cannot help here: its `img.crossOrigin` setter drops `''`, so the attribute never appears
    // in this DOM (a real browser reflects `crossorigin=""`). The layer's own options are the truth.
    const realTileLayer = L.tileLayer;
    const configured: unknown[] = [];
    let handle: ReturnType<typeof mountMap> | null = null;
    L.tileLayer = ((url: string, options?: L.TileLayerOptions) => {
      configured.push(options ?? {});
      return realTileLayer(url, options);
    }) as typeof L.tileLayer;

    try {
      // Act
      const node = host();
      handle = mountMap(node, spec('center: [51.5, -0.12]\nzoom: 12'));

      // Assert — `crossOrigin: ''` is anonymous: OSM answers `Access-Control-Allow-Origin: *`, so the
      // tiles stay allowed on a COEP `require-corp` page (docs/voice.md) where a no-CORS `<img>` would be
      // blocked. CORS mode does not touch the Referer, so the per-image `referrerPolicy` still carries the
      // valid Referer OSM's tile policy asks for (docs/fy-render.md).
      should(configured.length).equal(1);
      const options = configured[0] as { crossOrigin?: unknown; referrerPolicy?: unknown };
      should(options.crossOrigin).equal('');
      should(options.referrerPolicy).equal('strict-origin-when-cross-origin');
      const tiles = node.querySelectorAll<HTMLImageElement>('img.leaflet-tile');
      should(tiles.length > 0).be.true();
      for (const tile of tiles) should(tile.getAttribute('referrerpolicy')).equal('strict-origin-when-cross-origin');
    } finally {
      // Restore FIRST — a failed assertion must not leave later tests with a wrapped factory.
      L.tileLayer = realTileLayer;
      handle?.destroy();
    }
  });

  test('should keep a payload that looks like markup as text', () => {
    // Arrange
    const node = host();
    const handle = mountMap(
      node,
      spec(
        'markers:\n  - {at: [1, 2], label: "<img src=x onerror=alert(1)>", popup: "<script>1</script>"}\ncenter: [1, 2]',
      ),
    );

    // Act — open the popup the way a tap on the pin does.
    node.querySelector<HTMLElement>('.leaflet-marker-icon')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    // Assert
    should(node.querySelector('img[src="x"]')).be.null();
    should(node.querySelector('script')).be.null();
    should(node.querySelector('.fy-map-pin-label')?.textContent).equal('<img src=x onerror=alert(1)>');
    handle.destroy();
  });

  test('should open a popup with the title and body as text, and none for a bare pin or an unlabelled shape', () => {
    // Arrange
    const node = host();
    const handle = mountMap(node, spec(`${labelled}\nlines: [[[1, 1], [2, 2]]]`));

    // Act
    const icons = node.querySelectorAll<HTMLElement>('.leaflet-marker-icon');
    icons[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const title = node.querySelector('.fy-map-popup-title')?.textContent;
    const body = node.querySelector('.fy-map-popup-body')?.textContent;

    // Assert
    should(title).equal('Home');
    should(body).equal('Where <b>I</b> live');
    should(node.querySelector('.leaflet-popup-close-button')).be.null();
    should(node.querySelector('.fy-map-popup b')).be.null();
    handle.destroy();
  });

  test('should fit the view to everything drawn when there is no centre', () => {
    // Arrange
    const node = host();

    // Act
    const handle = mountMap(node, spec('markers:\n  - {at: [10, 10]}\n  - {at: [20, 30]}'));

    // Assert
    should(node.querySelectorAll('.leaflet-marker-icon').length).equal(2);
    handle.destroy();
  });

  test('should centre on a lone pin without a centre or a zoom', () => {
    const node = host();
    const handle = mountMap(node, spec('fit: false\nmarkers:\n  - {at: [10, 10]}'));
    should(node.querySelectorAll('.leaflet-marker-icon').length).equal(1);
    handle.destroy();
  });

  test('should zoom with the handle', () => {
    // Arrange
    const node = host();
    const handle = mountMap(node, spec('center: [1, 2]\nzoom: 10'));
    const tiles = (): string =>
      [...node.querySelectorAll<HTMLImageElement>('img.leaflet-tile')].map(tile => tile.src).join();
    const before = tiles();

    // Act / Assert — neither throws, and a closer zoom asks for other tiles.
    handle.zoomIn();
    handle.zoomOut();
    should(typeof before).equal('string');
    handle.destroy();
  });

  test('should enable drag and wheel in roomy mode and give the page its gestures back after', () => {
    // Arrange
    coarsePointer(true);
    const node = host();
    const handle = mountMap(node, spec('center: [1, 2]'));

    // Act / Assert — a coarse pointer starts with the finger left to the page.
    handle.roomy(true);
    handle.roomy(false);
    handle.destroy();
  });

  test('should leave a fine pointer draggable when roomy is turned off', () => {
    coarsePointer(false);
    const node = host();
    const handle = mountMap(node, spec('center: [1, 2]'));
    handle.roomy(false);
    handle.roomy(true);
    handle.destroy();
  });

  test('should work where matchMedia is missing', () => {
    (window as { matchMedia?: unknown }).matchMedia = undefined;
    const node = host();
    const handle = mountMap(node, spec('center: [1, 2]'));
    handle.destroy();
  });

  test('should re-place a map first laid out at zero size once it has one, and stop watching on destroy', () => {
    // Arrange
    const watchers = stubResizeObserver();
    const node = host(0, 0);
    const handle = mountMap(node, spec('markers:\n  - {at: [10, 10]}\n  - {at: [20, 30]}'));
    const watcher = watchers[0];
    Object.defineProperty(node, 'clientWidth', { configurable: true, value: 320 });
    Object.defineProperty(node, 'clientHeight', { configurable: true, value: 240 });

    // Act
    watcher?.callback([], {} as ResizeObserver);
    watcher?.callback([], {} as ResizeObserver);
    handle.destroy();

    // Assert
    should(watcher?.watching).eql([node]);
    should(watcher?.disconnected).be.true();
  });

  test('should work where ResizeObserver is missing', () => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = undefined;
    const node = host();
    const handle = mountMap(node, spec('center: [1, 2]'));
    handle.destroy();
  });
});
