import { afterEach, describe, expect, test } from 'bun:test';
import {
  readViewport,
  type ViewportEnvironment,
  ViewportDetails,
  ViewportOverlay,
  viewportOverlay,
} from '../../../../src/features/settings/viewport-details.tsx';
import { interact, mount, must } from '../../../support/dom.ts';

/** A window that records who listens, so a test can fire a resize and see every listener leave. */
const fakeWindow = (overrides: Partial<ViewportEnvironment['window']> = {}) => {
  const listeners = new Map<string, Set<() => void>>();
  const announcer = (prefix: string) => ({
    addEventListener: (type: string, listener: () => void) => {
      const set = listeners.get(`${prefix}${type}`) ?? new Set();
      set.add(listener);
      listeners.set(`${prefix}${type}`, set);
    },
    removeEventListener: (type: string, listener: () => void) => listeners.get(`${prefix}${type}`)?.delete(listener),
  });
  let innerHeight = 852;
  const window: ViewportEnvironment['window'] = {
    ...announcer('window:'),
    innerWidth: 393,
    get innerHeight() {
      return innerHeight;
    },
    screen: { width: 393, height: 852 },
    visualViewport: { ...announcer('visual:'), height: 852, offsetTop: 0 },
    navigator: { standalone: true },
    matchMedia: (query: string) => ({ matches: query === '(display-mode: standalone)' }),
    ...overrides,
  };
  return {
    window,
    environment: (): ViewportEnvironment => ({ window, document }),
    emit: (key: string) => {
      for (const listener of listeners.get(key) ?? []) listener();
    },
    listening: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
    setInnerHeight: (next: number) => {
      innerHeight = next;
    },
  };
};

/** The pieces of a chat screen the readout looks for, one of them in a hidden tab panel. */
const chatScene = (): HTMLElement => {
  const scene = document.createElement('div');
  scene.innerHTML = `
    <div class="kt-shell">
      <div hidden><nav data-safe-bottom="" data-which="hidden"></nav></div>
      <div class="fy-chat-input" data-safe-bottom="" data-which="shown"><div class="fy-composer"></div></div>
      <div class="fy-jump-latest-shell"><button class="fy-jump-latest">Jump</button></div>
    </div>`;
  document.body.append(scene);
  return scene;
};

afterEach(() => {
  viewportOverlay.set(false);
  document.documentElement.removeAttribute('data-keyboard');
  document.documentElement.style.removeProperty('--app-h');
});

describe('readViewport', () => {
  test('reads an installed iPhone: display mode, iOS standalone, the visual viewport and the shown bar', () => {
    // Arrange
    const scene = chatScene();
    const fake = fakeWindow();
    document.documentElement.setAttribute('data-keyboard', 'open');
    document.documentElement.style.setProperty('--app-h', '430px');

    try {
      // Act
      const reading = readViewport(fake.environment());

      // Assert
      expect(reading.displayMode).toBe('standalone');
      expect(reading.iosStandalone).toBe(true);
      expect(reading.screen).toEqual({ width: 393, height: 852 });
      expect([reading.innerWidth, reading.innerHeight]).toEqual([393, 852]);
      expect(reading.visual).toEqual({ height: 852, offsetTop: 0 });
      expect(reading.keyboardOpen).toBe(true);
      expect(reading.appHeight).toBe('430px');
      expect(reading.shell).not.toBeNull();
      expect(reading.bottomBar).not.toBeNull();
      expect(reading.composer).not.toBeNull();
      expect(reading.jumpPill).not.toBeNull();
      expect(Object.keys(reading.units)).toEqual(['vh', 'dvh', 'svh', 'lvh']);
      expect(Object.keys(reading.insets)).toEqual(['top', 'right', 'bottom', 'left']);
      // Every measuring box is gone again.
      expect(document.querySelectorAll('[data-viewport-probe]')).toHaveLength(0);
    } finally {
      scene.remove();
    }
  });

  test('a browser with no display-mode query, no visual viewport and no iOS flag reads as a plain tab', () => {
    const { matchMedia: _drop, ...bare } = fakeWindow({ visualViewport: null, navigator: {} }).window;
    const reading = readViewport({ window: bare, document });
    expect(reading.displayMode).toBe('browser');
    expect(reading.iosStandalone).toBeNull();
    expect(reading.visual).toBeNull();
    expect(reading.keyboardOpen).toBe(false);
    expect(reading.appHeight).toBeNull();
    expect([reading.shell, reading.bottomBar, reading.composer, reading.jumpPill]).toEqual([null, null, null, null]);
  });

  test('a bar inside a hidden tab panel is not the bar on screen', () => {
    const scene = document.createElement('div');
    scene.innerHTML = '<div hidden><nav data-safe-bottom=""></nav></div>';
    document.body.append(scene);
    try {
      expect(readViewport(fakeWindow().environment()).bottomBar).toBeNull();
    } finally {
      scene.remove();
    }
  });
});

describe('ViewportDetails', () => {
  const open = async (container: HTMLElement): Promise<HTMLDetailsElement> => {
    const details = must(container.querySelector<HTMLDetailsElement>('[data-viewport-details]'), 'the disclosure');
    await interact(() => {
      details.open = true;
      details.dispatchEvent(new Event('toggle'));
    });
    return details;
  };

  test('reads nothing while closed, then reads live while open and stops when closed again', async () => {
    // Arrange
    const fake = fakeWindow();
    const subject = await mount(<ViewportDetails environment={fake.environment} />);
    try {
      expect(subject.container.querySelector('[data-viewport-readout]')).toBeNull();
      expect(fake.listening()).toBe(0);

      // Act
      const details = await open(subject.container);

      // Assert
      expect(subject.container.querySelector('[data-viewport-readout]')).not.toBeNull();
      expect(subject.container.textContent).toContain('393px × 852px');
      expect(fake.listening()).toBe(4);
      fake.setInnerHeight(793);
      await interact(() => fake.emit('visual:resize'));
      expect(subject.container.textContent).toContain('393px × 793px');
      expect(subject.container.querySelector('[data-viewport-finding="off"]')?.textContent).toContain(
        '59px shorter than the screen',
      );

      await interact(() => {
        details.open = false;
        details.dispatchEvent(new Event('toggle'));
      });
      expect(subject.container.querySelector('[data-viewport-readout]')).toBeNull();
      expect(fake.listening()).toBe(0);
    } finally {
      await subject.unmount();
    }
  });

  test('re-reads on its own tick, so a pill that appears while it is open is picked up', async () => {
    const fake = fakeWindow();
    const subject = await mount(<ViewportDetails environment={fake.environment} />);
    try {
      await open(subject.container);
      fake.setInnerHeight(700);
      await interact(() => new Promise(resolve => setTimeout(resolve, 600)));
      expect(subject.container.textContent).toContain('393px × 700px');
    } finally {
      await subject.unmount();
    }
  });

  test('"Show over the app" pins the readout over every screen until it is closed', async () => {
    // Arrange
    const fake = fakeWindow();
    const overlay = await mount(<ViewportOverlay environment={fake.environment} />);
    const subject = await mount(<ViewportDetails environment={fake.environment} />);
    const toggle = () =>
      must(subject.container.querySelector<HTMLButtonElement>('[data-viewport-overlay-toggle]'), 'the switch');
    try {
      expect(overlay.container.querySelector('[data-viewport-overlay]')).toBeNull();
      await open(subject.container);

      // Act
      await interact(() => toggle().click());

      // Assert
      expect(toggle().textContent).toBe('Stop showing over the app');
      expect(overlay.container.querySelector('[data-viewport-overlay]')?.textContent).toContain('Display mode');
      await interact(() => toggle().click());
      expect(overlay.container.querySelector('[data-viewport-overlay]')).toBeNull();

      await interact(() => toggle().click());
      const close = must(
        overlay.container.querySelector<HTMLButtonElement>('[aria-label="Close viewport details"]'),
        'the close button',
      );
      await interact(() => close.click());
      expect(overlay.container.querySelector('[data-viewport-overlay]')).toBeNull();
      expect(toggle().textContent).toBe('Show over the app');
    } finally {
      await subject.unmount();
      await overlay.unmount();
    }
  });

  test('defaults to this browser: the real window and document', async () => {
    const overlay = await mount(<ViewportOverlay />);
    const subject = await mount(<ViewportDetails />);
    try {
      await open(subject.container);
      expect(subject.container.querySelector('[data-viewport-readout]')).not.toBeNull();
      await interact(() => viewportOverlay.set(true));
      // Setting the switch to where it already is announces nothing.
      viewportOverlay.set(true);
      expect(overlay.container.querySelector('[data-viewport-overlay]')).not.toBeNull();
    } finally {
      await subject.unmount();
      await overlay.unmount();
    }
  });
});
