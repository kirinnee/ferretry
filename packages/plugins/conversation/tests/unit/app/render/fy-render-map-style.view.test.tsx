import { afterEach, beforeEach, describe, test } from 'bun:test';
import { act } from 'react';
import should from 'should';
import { interact, type Mounted, mount, must, settleUntil } from '@ferretry/app/testing';
import { FyRenderMap, type FyRenderMapModules } from '../../../../app/render/fy-render-map.tsx';
import type { MapHandle } from '../../../../app/render/fy-render-map-engine.ts';
import { readMap } from '../../../../app/render/fy-render-map-model.ts';
import {
  MapStyleRow,
  changeMapChoice,
  resetMapChoiceForTest,
} from '../../../../app/render/fy-render-map-style-row.tsx';
import { DEFAULT_MAP_CHOICE, type MapChoiceStorage } from '../../../../app/render/fy-render-map-style.ts';

/** A FAKE key of the right shape. No real key is ever written in a test, a capture or a message. */
const FAKE_KEY = 'AIzaFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE0';
const PIN = 'center: [51.5, -0.12]\nzoom: 12\nmarkers:\n  - {at: [51.5, -0.12], label: Home}';
const ROUTE = 'center: [51.5, -0.12]\nlines:\n  - {points: [[51.5, -0.12], [51.6, -0.1]]}';

/** A working storage that keeps what it is given, so a test can set a choice up without touching the real one. */
const memory = (): MapChoiceStorage => {
  const items = new Map<string, string>();
  return {
    getItem: name => items.get(name) ?? null,
    removeItem: name => void items.delete(name),
    setItem: (name, value) => void items.set(name, value),
  };
};

/** The page's own `localStorage`, swapped for `value` ('blocked' makes every touch throw, as a browser that blocks site data does). */
const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const useStorage = (value: MapChoiceStorage | 'blocked'): void => {
  if (value === 'blocked')
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    });
  else Object.defineProperty(globalThis, 'localStorage', { configurable: true, value });
};
const restoreStorage = (): void => {
  if (original) Object.defineProperty(globalThis, 'localStorage', original);
  else Reflect.deleteProperty(globalThis, 'localStorage');
};

const calls: string[] = [];
const handle: MapHandle = {
  destroy: () => calls.push('destroy'),
  roomy: () => {},
  zoomIn: () => {},
  zoomOut: () => {},
};
const modules: FyRenderMapModules = {
  mountMap: () => {
    calls.push('mount');
    return handle;
  },
  readMap,
};

const mounted: Mounted[] = [];
const show = async (element: React.ReactElement): Promise<Mounted> => {
  const one = await mount(element);
  mounted.push(one);
  return one;
};
const settle = (ready: () => boolean, what: string): Promise<void> =>
  settleUntil(ready, what, callback => act(callback));
const noop = (): void => {};
const map = (payload: string) => (
  <FyRenderMap
    alt="Home"
    environment={{ credentialless: true, isolated: false }}
    fullscreen={false}
    load={async () => modules}
    mode="light"
    onListing={noop}
    payload={payload}
  />
);

beforeEach(() => {
  calls.length = 0;
  useStorage(memory());
  resetMapChoiceForTest();
  changeMapChoice(DEFAULT_MAP_CHOICE, null);
});
afterEach(async () => {
  restoreStorage();
  for (const one of mounted.splice(0)) await one.unmount();
});

describe('FyRenderMap — map style', () => {
  test('should draw with OpenStreetMap and frame nothing by default', async () => {
    const view = await show(map(PIN));
    await settle(() => calls.includes('mount'), 'the map to mount');
    should(view.container.querySelector('iframe')).be.null();
  });

  test('should frame the Google embed, credentialless and sandboxed, once chosen with a key', async () => {
    changeMapChoice({ key: FAKE_KEY, style: 'google' }, memory());
    const view = await show(map(PIN));
    await settle(() => view.container.querySelector('iframe') !== null, 'the Google frame');
    const frame = must(view.container.querySelector('iframe'), 'the frame');
    should(frame.getAttribute('src')?.startsWith('https://www.google.com/maps/embed/v1/place?')).be.true();
    should(frame.hasAttribute('credentialless')).be.true();
    should(frame.getAttribute('referrerpolicy')).equal('origin');
    should(frame.getAttribute('sandbox')).not.containEql('allow-top-navigation');
    should(frame.hasAttribute('allow')).be.false();
    should(frame.getAttribute('title')).not.containEql(FAKE_KEY);
    should(calls).not.containEql('mount');
    should(view.container.textContent).containEql('Home');
    should(view.container.textContent).not.containEql(FAKE_KEY);
  });

  test('should stay on OpenStreetMap and say the key is needed when Google is chosen with none', async () => {
    changeMapChoice({ key: null, style: 'google' }, memory());
    const view = await show(map(PIN));
    await settle(() => calls.includes('mount'), 'the map to mount');
    should(view.container.querySelector('iframe')).be.null();
    should(view.container.textContent).containEql('needs its key on this device');
  });

  test('should fall back to OpenStreetMap with a note for a route', async () => {
    changeMapChoice({ key: FAKE_KEY, style: 'google' }, memory());
    const view = await show(map(ROUTE));
    await settle(() => calls.includes('mount'), 'the map to mount');
    should(view.container.querySelector('iframe')).be.null();
    should(view.container.textContent).containEql("can't draw routes or shapes");
  });

  test('should switch an open map when the choice changes', async () => {
    const view = await show(map(PIN));
    await settle(() => calls.includes('mount'), 'the map to mount');
    await interact(() => void changeMapChoice({ key: FAKE_KEY, style: 'google' }, memory()));
    await settle(() => view.container.querySelector('iframe') !== null, 'the Google frame');
    should(calls).containEql('destroy');
  });
});

describe('MapStyleRow', () => {
  const typeKey = async (view: Mounted, value: string): Promise<void> => {
    const input = must(view.container.querySelector<HTMLInputElement>('[data-map-style-key="input"]'), 'the key input');
    await interact(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      set?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const press = (view: Mounted, which: string) =>
    interact(() => must(view.container.querySelector<HTMLElement>(`[data-map-style-key="${which}"]`), which).click());

  test('should say plainly that the key is browser-visible and stays in this browser', async () => {
    const view = await show(<MapStyleRow />);
    const text = view.container.textContent ?? '';
    should(text).containEql('browser-visible by Google');
    should(text).containEql('stored in this browser only');
    should(text).containEql('never sent to the daemon');
    should(text).containEql('No key on this device');
  });

  test('should keep a typed key, show a mask and never put the value in the page', async () => {
    const view = await show(<MapStyleRow />);
    await typeKey(view, FAKE_KEY);
    await press(view, 'save');
    should(view.container.querySelector('[data-map-style-key="stored"]')).not.be.null();
    should(view.container.innerHTML).not.containEql(FAKE_KEY);
    should(view.container.textContent).containEql('A key is stored on this device');
  });

  test('should refuse something that is not a key, and keep nothing', async () => {
    const view = await show(<MapStyleRow />);
    await typeKey(view, 'not a key');
    await press(view, 'save');
    should(view.container.querySelector('[data-map-style-key="problem"]')?.textContent).containEql(
      'not a Google Maps key',
    );
    should(view.container.querySelector('[data-map-style-key="stored"]')).be.null();
  });

  test('should remove the key again', async () => {
    changeMapChoice({ key: FAKE_KEY, style: 'google' }, memory());
    const view = await show(<MapStyleRow />);
    await press(view, 'remove');
    should(view.container.querySelector('[data-map-style-key="input"]')).not.be.null();
  });

  const pickGoogle = (view: Mounted) =>
    interact(() =>
      must(view.container.querySelector<HTMLInputElement>('input[type="radio"][value="google"]'), 'Google').click(),
    );

  test('should keep OpenStreetMap, say the key is needed and frame nothing when this browser will not keep the key', async () => {
    useStorage('blocked');
    const view = await show(
      <>
        <MapStyleRow />
        {map(PIN)}
      </>,
    );
    await settle(() => calls.includes('mount'), 'the map to mount');
    await pickGoogle(view);
    await typeKey(view, FAKE_KEY);
    await press(view, 'save');
    await settle(() => calls.filter(call => call === 'mount').length >= 1, 'the map to settle');
    should(view.container.querySelector('iframe')).be.null();
    should(view.container.textContent).containEql('needs its key on this device');
    should(view.container.querySelector('[data-map-style-key="problem"]')?.textContent).containEql(
      'would not keep the key',
    );
    // The key is not held for the tab either: nothing is stored and the box is back.
    should(view.container.querySelector('[data-map-style-key="stored"]')).be.null();
    should(view.container.querySelector('[data-map-style-key="input"]')).not.be.null();
    should(view.container.innerHTML).not.containEql(FAKE_KEY);
  });

  test('should say so when the key could not be removed, because it may still be stored', async () => {
    const storage = memory();
    useStorage(storage);
    changeMapChoice({ key: FAKE_KEY, style: 'google' }, storage);
    useStorage({
      getItem: name => storage.getItem(name),
      removeItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
      setItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    });
    const view = await show(<MapStyleRow />);
    await press(view, 'remove');
    should(view.container.querySelector('[data-map-style-key="problem"]')?.textContent).containEql(
      'may still be stored',
    );
  });
});
