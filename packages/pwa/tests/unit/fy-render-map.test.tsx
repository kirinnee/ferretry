import { afterEach, describe, test } from 'bun:test';
import { act } from 'react';
import should from 'should';
import { FyRenderMap, type FyRenderMapModules } from '../../src/components/fy-render-map.tsx';
import type { MapHandle } from '../../src/components/fy-render-map-engine.ts';
import { readMap } from '../../src/lib/fy-render-map.ts';
import { MapStyleProvider } from '../../src/lib/map-style-context.tsx';
import type { MapEnvironment } from '../../src/lib/map-style.ts';
import { interact, type Mounted, mount, must } from '../support/dom.ts';
import { settleUntil } from '../support/settle.ts';

/**
 * The map component, mounted in a real document with the engine replaced by a recorder, so what is
 * claimed is the component's own behaviour: when it draws, what it shows instead, what its controls call.
 * The real engine is exercised in `fy-render-map-engine.test.ts`, and once more here through the default
 * loader (the last test), which is the only place the lazy chunk's wiring is proven.
 */

const PAYLOAD = 'center: [51.5, -0.12]\nzoom: 12\nmarkers:\n  - {at: [51.5, -0.12], label: Home}';

interface Recorder {
  readonly calls: string[];
  readonly hosts: HTMLElement[];
  readonly modules: FyRenderMapModules;
}

const recorder = (): Recorder => {
  const calls: string[] = [];
  const hosts: HTMLElement[] = [];
  const handle: MapHandle = {
    destroy: () => calls.push('destroy'),
    roomy: roomy => calls.push(`roomy:${roomy}`),
    zoomIn: () => calls.push('zoomIn'),
    zoomOut: () => calls.push('zoomOut'),
  };
  return {
    calls,
    hosts,
    modules: {
      mountMap: host => {
        hosts.push(host);
        calls.push('mount');
        return handle;
      },
      readMap,
    },
  };
};

const mounted: Mounted[] = [];
afterEach(async () => {
  for (const one of mounted.splice(0)) await one.unmount();
});

const show = async (element: React.ReactElement): Promise<Mounted> => {
  const one = await mount(element);
  mounted.push(one);
  return one;
};

const settle = (ready: () => boolean, what: string): Promise<void> =>
  settleUntil(ready, what, callback => act(callback));

const noop = (): void => {};

describe('FyRenderMap', () => {
  test('should draw into its canvas once the modules load and enable its zoom buttons', async () => {
    // Arrange
    const fake = recorder();
    const told: boolean[] = [];

    // Act
    const view = await show(
      <FyRenderMap
        alt="London"
        fullscreen={false}
        load={async () => fake.modules}
        mode="light"
        onListing={listing => told.push(listing)}
        payload={PAYLOAD}
      />,
    );
    await settle(() => fake.calls.includes('mount'), 'the map to mount');

    // Assert
    const root = must(view.container.querySelector('[data-fy-render-map]'), 'the map');
    should(root.getAttribute('data-fy-render-map')).equal('drawn');
    should(root.getAttribute('data-fy-render-map-mode')).equal('light');
    should(fake.hosts[0]).equal(view.container.querySelector('.fy-render-map-canvas'));
    should(view.container.querySelector('.fy-render-map-canvas')?.getAttribute('aria-label')).equal('Map: London');
    const buttons = [...view.container.querySelectorAll('button')];
    should(buttons.map(button => button.getAttribute('aria-label'))).eql(['Zoom in', 'Zoom out']);
    should(buttons.every(button => !button.disabled)).be.true();
    const attribution = must(view.container.querySelector('a'), 'the attribution');
    should(attribution.textContent).containEql('OpenStreetMap');
    should(attribution.getAttribute('rel')).equal('noopener noreferrer');
    should(told.at(-1)).be.false();
  });

  test('should keep its zoom buttons disabled while loading', async () => {
    // Arrange
    const view = await show(
      <FyRenderMap
        alt="London"
        fullscreen={false}
        load={() => new Promise(noop)}
        mode="dark"
        onListing={noop}
        payload={PAYLOAD}
      />,
    );

    // Assert
    should(view.container.querySelector('[data-fy-render-map]')?.getAttribute('data-fy-render-map')).equal('loading');
    should([...view.container.querySelectorAll('button')].every(button => button.disabled)).be.true();
  });

  test('should call the handle from the zoom buttons', async () => {
    // Arrange
    const fake = recorder();
    const view = await show(
      <FyRenderMap
        alt="London"
        fullscreen={false}
        load={async () => fake.modules}
        mode="light"
        onListing={noop}
        payload={PAYLOAD}
      />,
    );
    await settle(() => fake.calls.includes('mount'), 'the map to mount');
    const [zoomIn, zoomOut] = [...view.container.querySelectorAll('button')];

    // Act
    await interact(() => zoomIn?.click());
    await interact(() => zoomOut?.click());

    // Assert
    should(fake.calls).containEql('zoomIn');
    should(fake.calls).containEql('zoomOut');
  });

  test('should hand the map the whole plane in fullscreen and take it back', async () => {
    // Arrange
    const fake = recorder();
    const element = (fullscreen: boolean) => (
      <FyRenderMap
        alt="London"
        fullscreen={fullscreen}
        load={async () => fake.modules}
        mode="light"
        onListing={noop}
        payload={PAYLOAD}
      />
    );
    const view = await show(element(false));
    await settle(() => fake.calls.includes('roomy:false'), 'the map to be told its room');

    // Act
    await view.render(element(true));
    await view.render(element(false));

    // Assert
    should(fake.calls.filter(call => call.startsWith('roomy'))).eql(['roomy:false', 'roomy:true', 'roomy:false']);
  });

  test('should destroy the map when it unmounts', async () => {
    // Arrange
    const fake = recorder();
    const view = await show(
      <FyRenderMap
        alt="London"
        fullscreen={false}
        load={async () => fake.modules}
        mode="light"
        onListing={noop}
        payload={PAYLOAD}
      />,
    );
    await settle(() => fake.calls.includes('mount'), 'the map to mount');

    // Act
    await view.unmount();
    mounted.length = 0;

    // Assert
    should(fake.calls.at(-1)).equal('destroy');
  });

  test('should mount nothing if it unmounts before the modules arrive', async () => {
    // Arrange
    const fake = recorder();
    let arrive: (modules: FyRenderMapModules) => void = noop;
    const view = await show(
      <FyRenderMap
        alt="London"
        fullscreen={false}
        load={() => new Promise(resolve => (arrive = resolve))}
        mode="light"
        onListing={noop}
        payload={PAYLOAD}
      />,
    );
    await view.unmount();
    mounted.length = 0;

    // Act
    arrive(fake.modules);
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
    });

    // Assert
    should(fake.calls).eql([]);
  });

  test('should list the coordinates it can find, and say why, for a payload it refuses', async () => {
    // Arrange
    const fake = recorder();
    const told: boolean[] = [];

    // Act
    const view = await show(
      <FyRenderMap
        alt="London"
        fullscreen={false}
        load={async () => fake.modules}
        mode="light"
        onListing={listing => told.push(listing)}
        payload={'zoom: 99\nmarkers:\n  - {at: [51.5, -0.12], label: Home}'}
      />,
    );
    await settle(() => told.at(-1) === true, 'the listing');

    // Assert
    const root = must(view.container.querySelector('[data-fy-render-map]'), 'the listing');
    should(root.getAttribute('data-fy-render-map')).equal('listing');
    should(root.querySelector('.fy-render-stopped')?.textContent).equal('zoom must be a number from 0 to 18.');
    should(root.querySelector('ul')?.getAttribute('aria-label')).equal('Coordinates: London');
    should([...root.querySelectorAll('li')].map(item => item.textContent)).eql(['Point: 51.5, -0.12']);
    should(view.container.querySelector('button')).be.null();
    should(fake.calls).eql([]);
  });

  test('should show only the reason when a refused payload holds no coordinates', async () => {
    // Arrange
    const fake = recorder();
    const told: boolean[] = [];

    // Act
    const view = await show(
      <FyRenderMap
        alt="London"
        fullscreen={false}
        load={async () => fake.modules}
        mode="light"
        onListing={listing => told.push(listing)}
        payload="a: [1, 2"
      />,
    );
    await settle(() => told.at(-1) === true, 'the listing');

    // Assert
    should(view.container.querySelector('.fy-render-stopped')?.textContent).equal(
      'The map description is not valid JSON or YAML.',
    );
    should(view.container.querySelector('ul')).be.null();
  });

  test('should fall back to the quiet note when the engine cannot be loaded', async () => {
    // Arrange
    const told: boolean[] = [];

    // Act
    const view = await show(
      <FyRenderMap
        alt="London"
        fullscreen={false}
        load={() => Promise.reject(new Error('offline'))}
        mode="light"
        onListing={listing => told.push(listing)}
        payload={PAYLOAD}
      />,
    );
    await settle(() => told.at(-1) === true, 'the load failure');

    // Assert
    should(view.container.querySelector('.fy-render-stopped')?.textContent).equal('The map could not be loaded.');
  });

  test('should ignore a load failure that arrives after it unmounted', async () => {
    // Arrange
    let fail: (reason: Error) => void = noop;
    const view = await show(
      <FyRenderMap
        alt="London"
        fullscreen={false}
        load={() => new Promise((_resolve, reject) => (fail = reject))}
        mode="light"
        onListing={noop}
        payload={PAYLOAD}
      />,
    );
    await view.unmount();
    mounted.length = 0;

    // Act / Assert — nothing throws and nothing is set on a gone component.
    fail(new Error('late'));
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
    });
  });

  test('should load the real engine through its default loader and draw a Leaflet map', async () => {
    // Arrange / Act
    const view = await show(
      <FyRenderMap alt="London" fullscreen={false} mode="light" onListing={noop} payload={PAYLOAD} />,
    );
    await settle(
      () => view.container.querySelector('[data-fy-render-map]')?.getAttribute('data-fy-render-map') === 'drawn',
      'the real engine to draw',
    );

    // Assert
    should(view.container.querySelector('.leaflet-container')).not.be.null();
    should(view.container.querySelectorAll('.fy-map-pin').length).equal(1);
  });
});

describe('FyRenderMap in the Google Maps style', () => {
  const KEY = 'AIzaFAKEfakeFAKEfakeFAKEfakeFAKEfake00';
  const CHROMIUM: MapEnvironment = { credentialless: true, isolated: false };
  const ISOLATED_SAFARI: MapEnvironment = { credentialless: false, isolated: true };
  const PIN = 'markers:\n  - {at: [51.5007, -0.1246], label: Big Ben}';

  const showGoogle = async (payload: string, environment: MapEnvironment, key: string | null = KEY) => {
    const fake = recorder();
    const view = await show(
      <MapStyleProvider embedKey={key} style="google">
        <FyRenderMap
          alt="London"
          environment={environment}
          fullscreen={false}
          load={async () => fake.modules}
          mode="dark"
          onListing={noop}
          payload={payload}
        />
      </MapStyleProvider>,
    );
    return { fake, view };
  };

  test('should frame a lone marker instead of mounting Leaflet, with the frame locked down', async () => {
    // Act
    const { fake, view } = await showGoogle(PIN, CHROMIUM);
    await settle(() => view.container.querySelector('iframe') !== null, 'the frame');

    // Assert
    const frame = must(view.container.querySelector('iframe'), 'the frame');
    should(frame.getAttribute('src')).startWith('https://www.google.com/maps/embed/v1/place?');
    should(frame.hasAttribute('credentialless')).be.true();
    should(frame.getAttribute('referrerpolicy')).equal('origin');
    should(frame.getAttribute('sandbox')).containEql('allow-scripts').and.not.containEql('allow-top-navigation');
    should(frame.getAttribute('title')).equal('Map: London (Google Maps)');
    should(fake.calls).eql([]);
    should(view.container.querySelector('.fy-render-map-note')?.textContent).equal('Big Ben');
    should([...view.container.querySelectorAll('button')]).have.length(0);
  });

  test('should keep the map and its note inside one wrapper, not as siblings of the stage', async () => {
    // Act
    const { view } = await showGoogle(PIN, CHROMIUM);
    await settle(() => view.container.querySelector('.fy-render-map-note') !== null, 'the note');

    // Assert
    const block = must(view.container.querySelector('.fy-render-map-block'), 'the wrapper');
    const note = must(view.container.querySelector('.fy-render-map-note'), 'the note');
    should(view.container.firstElementChild).equal(block);
    should(note.parentElement).equal(block);
    should(must(view.container.querySelector('.fy-render-map'), 'the map').parentElement).equal(block);
  });

  test('should say so, and mount OpenStreetMap, for a map Google cannot draw', async () => {
    // Act
    const { fake, view } = await showGoogle('markers:\n  - {at: [1, 2]}\n  - {at: [3, 4]}', CHROMIUM);
    await settle(() => fake.calls.includes('mount'), 'the map to mount');

    // Assert
    should(view.container.querySelector('iframe')).equal(null);
    should(view.container.querySelector('.fy-render-map-note')?.textContent).equal(
      "Shown with OpenStreetMap: Google Maps can't draw more than one marker here.",
    );
  });

  test('should say so, and mount OpenStreetMap, where isolation forbids a plain Google frame', async () => {
    // Act
    const { fake, view } = await showGoogle(PIN, ISOLATED_SAFARI);
    await settle(() => fake.calls.includes('mount'), 'the map to mount');

    // Assert
    should(view.container.querySelector('iframe')).equal(null);
    should(view.container.querySelector('.fy-render-map-note')?.textContent).containEql('several cores');
  });

  test('should draw OpenStreetMap, with no note, when the build has no key', async () => {
    // Act
    const { fake, view } = await showGoogle(PIN, CHROMIUM, null);
    await settle(() => fake.calls.includes('mount'), 'the map to mount');

    // Assert
    should(view.container.querySelector('iframe')).equal(null);
    should(view.container.querySelector('.fy-render-map-note')).equal(null);
  });

  describe('when the loader resolves immediately and the style or payload changes', () => {
    const element = (style: 'osm' | 'google', payload: string, fake: Recorder) => (
      <MapStyleProvider embedKey={KEY} style={style}>
        <FyRenderMap
          alt="London"
          environment={CHROMIUM}
          fullscreen={false}
          load={async () => fake.modules}
          mode="dark"
          onListing={noop}
          payload={payload}
        />
      </MapStyleProvider>
    );

    test('should mount OpenStreetMap after Google was shown, then the frame again', async () => {
      // Arrange
      const fake = recorder();
      const view = await show(element('google', PIN, fake));
      await settle(() => view.container.querySelector('iframe') !== null, 'the frame');
      const host = view.container.querySelector('.fy-render-map-canvas:not(iframe)');

      // Act: Google -> OpenStreetMap
      await view.render(element('osm', PIN, fake));
      await settle(() => fake.calls.includes('mount'), 'the map to mount');

      // Assert
      should(view.container.querySelector('iframe')).equal(null);
      should(fake.hosts).have.length(1);
      should(fake.hosts[0]).equal(view.container.querySelector('.fy-render-map-canvas'));
      should(fake.hosts[0]).equal(host);
      should((fake.hosts[0] as HTMLElement).hidden).be.false();
      should(view.container.querySelector('[data-fy-render-map]')?.getAttribute('data-fy-render-map')).equal('drawn');
      should(view.container.querySelector('.fy-render-map-note')).equal(null);

      // Act: OpenStreetMap -> Google
      await view.render(element('google', PIN, fake));
      await settle(() => view.container.querySelector('iframe') !== null, 'the frame again');

      // Assert
      should(fake.calls.filter(call => call === 'destroy')).have.length(1);
      should(view.container.querySelector('[data-fy-render-map]')?.getAttribute('data-fy-render-map')).equal('google');
      should(view.container.querySelectorAll('button')).have.length(0);
    });

    test('should re-frame the new place when a Google payload changes', async () => {
      // Arrange
      const fake = recorder();
      const view = await show(element('google', PIN, fake));
      await settle(() => view.container.querySelector('iframe') !== null, 'the first frame');
      const first = view.container.querySelector('iframe')?.getAttribute('src');

      // Act
      await view.render(element('google', 'markers:\n  - {at: [48.8584, 2.2945], label: Eiffel Tower}', fake));
      await settle(
        () => view.container.querySelector('iframe')?.getAttribute('src') !== first,
        'the frame to move to the new place',
      );

      // Assert
      const second = new URL(must(view.container.querySelector('iframe'), 'the frame').getAttribute('src') ?? '');
      should(second.searchParams.get('q')).equal('48.858400,2.294500');
      should(view.container.querySelectorAll('iframe')).have.length(1);
      should(view.container.querySelector('.fy-render-map-note')?.textContent).equal('Eiffel Tower');
      should(fake.calls).eql([]);
    });

    test('should drop a Google frame and caption for a payload Google cannot draw', async () => {
      // Arrange
      const fake = recorder();
      const view = await show(element('google', PIN, fake));
      await settle(() => view.container.querySelector('iframe') !== null, 'the frame');

      // Act
      await view.render(element('google', 'markers:\n  - {at: [1, 2]}\n  - {at: [3, 4]}', fake));
      await settle(() => fake.calls.includes('mount'), 'the map to mount');

      // Assert
      should(view.container.querySelector('iframe')).equal(null);
      should(view.container.querySelectorAll('.fy-render-map-note')).have.length(1);
      should(view.container.querySelector('.fy-render-map-note')?.textContent).containEql('more than one marker');
    });
  });
});
