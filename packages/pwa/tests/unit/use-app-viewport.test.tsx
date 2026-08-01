import { afterEach, describe, expect, it } from 'bun:test';

import {
  installAppViewport,
  KEYBOARD_MIN_PX,
  type AppViewportEnvironment,
  useAppViewport,
} from '../../src/hooks/use-app-viewport.ts';
import { KEYBOARD_ATTRIBUTE } from '../../src/hooks/use-keyboard-open.ts';
import '../support/dom.ts';
import { mount } from '../support/dom.ts';

class Events {
  readonly listeners = new Map<string, Set<() => void>>();
  add(type: string, listener: () => void): void {
    const set = this.listeners.get(type) ?? new Set<() => void>();
    set.add(listener);
    this.listeners.set(type, set);
  }
  remove(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

const makeEnvironment = () => {
  const viewportEvents = new Events();
  const windowEvents = new Events();
  const documentEvents = new Events();
  let width = 390;
  let innerHeight = 844;
  let visualHeight = 844;
  let offsetTop = 0;
  let coarse = true;
  let scroll = { x: 0, y: 0 };
  const frames = new Map<number, () => void>();
  let nextFrame = 1;
  const root = document.documentElement.cloneNode(false) as HTMLElement;
  const env: AppViewportEnvironment = {
    root,
    document: {
      get activeElement() {
        return document.activeElement;
      },
      addEventListener: documentEvents.add.bind(documentEvents),
      removeEventListener: documentEvents.remove.bind(documentEvents),
    },
    innerWidth: () => width,
    innerHeight: () => innerHeight,
    scroll: () => scroll,
    scrollTo: (x, y) => {
      scroll = { x, y };
    },
    visualViewport: {
      read: () => ({ height: visualHeight, offsetTop }),
      addEventListener: viewportEvents.add.bind(viewportEvents),
      removeEventListener: viewportEvents.remove.bind(viewportEvents),
    },
    coarsePointer: () => coarse,
    requestFrame: callback => {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    },
    cancelFrame: id => frames.delete(id),
    addWindowListener: windowEvents.add.bind(windowEvents),
    removeWindowListener: windowEvents.remove.bind(windowEvents),
  };
  return {
    env,
    root,
    viewportEvents,
    windowEvents,
    documentEvents,
    set: (
      next: Partial<{
        width: number;
        innerHeight: number;
        visualHeight: number;
        offsetTop: number;
        coarse: boolean;
        scroll: { x: number; y: number };
      }>,
    ) => {
      width = next.width ?? width;
      innerHeight = next.innerHeight ?? innerHeight;
      visualHeight = next.visualHeight ?? visualHeight;
      offsetTop = next.offsetTop ?? offsetTop;
      coarse = next.coarse ?? coarse;
      scroll = next.scroll ?? scroll;
    },
    flush: () => {
      for (const callback of frames.values()) callback();
      frames.clear();
    },
    frameCount: () => frames.size,
  };
};

afterEach(() => document.querySelector('input')?.remove());

describe('installAppViewport', () => {
  it('publishes the visual geometry, detects a focused phone keyboard, restores document scroll, and cleans up', () => {
    const fixture = makeEnvironment();
    fixture.set({ scroll: { x: 3, y: 4 } });
    const stop = installAppViewport(fixture.env);
    expect(fixture.root.style.getPropertyValue('--app-h')).toBe('844px');
    expect(fixture.root.style.getPropertyValue('--app-top')).toBe('0px');
    expect(fixture.root.getAttribute(KEYBOARD_ATTRIBUTE)).toBeNull();

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    fixture.set({ visualHeight: 500, offsetTop: 10 });
    fixture.viewportEvents.emit('resize');
    fixture.viewportEvents.emit('scroll');
    expect(fixture.frameCount()).toBe(1);
    fixture.flush();
    expect(fixture.root.style.getPropertyValue('--kb-h')).toBe(`${844 - 500 - 10}px`);
    expect(fixture.root.getAttribute(KEYBOARD_ATTRIBUTE)).toBe('open');

    fixture.set({ coarse: false, visualHeight: 844, offsetTop: -4 });
    fixture.windowEvents.emit('orientationchange');
    fixture.documentEvents.emit('visibilitychange');
    fixture.flush();
    expect(fixture.root.getAttribute(KEYBOARD_ATTRIBUTE)).toBeNull();
    expect(KEYBOARD_MIN_PX).toBe(120);

    fixture.viewportEvents.emit('resize');
    expect(fixture.frameCount()).toBe(1);
    stop();
    expect(fixture.frameCount()).toBe(0);
    fixture.viewportEvents.emit('resize');
    expect(fixture.frameCount()).toBe(0);
  });

  it('can mount the browser hook when visualViewport is absent, retaining the inner-height fallback', async () => {
    const Probe = () => {
      useAppViewport();
      return <span />;
    };
    const view = await mount(<Probe />);
    expect(document.documentElement.style.getPropertyValue('--app-h')).not.toBe('');
    await view.unmount();
  });

  it('adapts a native visualViewport when the browser provides one', async () => {
    const previous = Object.getOwnPropertyDescriptor(window, 'visualViewport');
    const listeners = new Set<() => void>();
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: {
        height: 600,
        offsetTop: 8,
        addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
      } as unknown as VisualViewport,
    });
    const Probe = () => {
      useAppViewport();
      return <span />;
    };
    try {
      const view = await mount(<Probe />);
      expect(document.documentElement.style.getPropertyValue('--app-h')).toBe('600px');
      expect(listeners.size).toBe(1);
      await view.unmount();
      expect(listeners.size).toBe(0);
    } finally {
      if (previous) Object.defineProperty(window, 'visualViewport', previous);
      else Reflect.deleteProperty(window, 'visualViewport');
    }
  });
});
