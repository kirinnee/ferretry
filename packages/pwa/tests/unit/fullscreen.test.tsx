import { afterEach, describe, expect, it } from 'bun:test';
import { FullscreenToggle } from '../../src/components/fullscreen-toggle.tsx';
import { SurfaceFrame } from '../../src/features/workspace/surface-frame.tsx';
import { useFullscreen } from '../../src/hooks/use-fullscreen.ts';
import { browserFullscreenPort, type FullscreenPort } from '../../src/lib/fullscreen.ts';
import { interact, mount, must, pressKey } from '../support/dom.ts';

interface FakePort extends FullscreenPort {
  readonly calls: string[];
  native: boolean;
  refuse: boolean;
  fullscreenElement: Element | null;
  emit(): void;
}

const fakePort = (patch: Partial<Pick<FakePort, 'native' | 'refuse'>> = {}): FakePort => {
  const listeners = new Set<() => void>();
  const port: FakePort = {
    calls: [],
    native: true,
    refuse: false,
    fullscreenElement: null,
    ...patch,
    canRequest: () => port.native,
    request: async element => {
      port.calls.push('request');
      if (port.refuse) throw new Error('refused');
      port.fullscreenElement = element;
    },
    exit: async () => {
      port.calls.push('exit');
      port.fullscreenElement = null;
    },
    current: () => port.fullscreenElement,
    subscribe: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: () => {
      for (const listener of [...listeners]) listener();
    },
  };
  return port;
};

function Probe({ port }: { readonly port: FullscreenPort }) {
  const fullscreen = useFullscreen<HTMLDivElement>(port);
  return (
    <div data-mode={fullscreen.mode} data-probe="" ref={fullscreen.ref}>
      <button data-toggle="" onClick={fullscreen.toggle} type="button" />
      <button data-exit="" onClick={fullscreen.exit} type="button" />
      <textarea data-keyboard-capture="" data-shell="" />
    </div>
  );
}

const modeOf = (container: HTMLElement): string | null =>
  must(container.querySelector('[data-probe]'), 'probe').getAttribute('data-mode');
const click = (container: HTMLElement, selector: string): Promise<void> =>
  interact(() => must(container.querySelector<HTMLElement>(selector), selector).click());

describe('useFullscreen', () => {
  it('goes native where the platform will, and leaves through its own exit', async () => {
    const port = fakePort();
    const view = await mount(<Probe port={port} />);
    expect(modeOf(view.container)).toBe('off');
    await click(view.container, '[data-toggle]');
    expect(modeOf(view.container)).toBe('native');
    await click(view.container, '[data-toggle]');
    expect(modeOf(view.container)).toBe('off');
    expect(port.calls).toEqual(['request', 'exit']);
    await view.unmount();
  });

  it('becomes a viewport overlay where the platform has no element full screen', async () => {
    const port = fakePort({ native: false });
    const view = await mount(<Probe port={port} />);
    await click(view.container, '[data-toggle]');
    expect(modeOf(view.container)).toBe('overlay');
    expect(port.calls).toEqual([]);
    await click(view.container, '[data-exit]');
    expect(modeOf(view.container)).toBe('off');
    expect(port.calls).toEqual([]);
    await view.unmount();
  });

  it('falls back to the overlay when the platform refuses the request', async () => {
    const port = fakePort({ refuse: true });
    const view = await mount(<Probe port={port} />);
    await click(view.container, '[data-toggle]');
    expect(modeOf(view.container)).toBe('overlay');
    await view.unmount();
  });

  it('mirrors the platform leaving full screen by its own gesture, and ignores other elements', async () => {
    const port = fakePort();
    const view = await mount(<Probe port={port} />);
    await click(view.container, '[data-toggle]');
    await interact(() => port.emit());
    expect(modeOf(view.container)).toBe('native');
    port.fullscreenElement = null;
    await interact(() => port.emit());
    expect(modeOf(view.container)).toBe('off');
    await view.unmount();
  });

  it('leaves on Escape, but keeps Escape for a keyboard-owning surface and leaves it on Shift+Escape', async () => {
    const port = fakePort({ native: false });
    const view = await mount(<Probe port={port} />);
    await click(view.container, '[data-toggle]');
    await interact(() => pressKey(document, 'a'));
    expect(modeOf(view.container)).toBe('overlay');
    const shell = must(view.container.querySelector('[data-shell]'), 'shell');
    await interact(() => pressKey(shell, 'Escape'));
    expect(modeOf(view.container)).toBe('overlay');
    await interact(() => pressKey(shell, 'Escape', { shiftKey: true }));
    expect(modeOf(view.container)).toBe('off');
    await click(view.container, '[data-toggle]');
    await interact(() => pressKey(document.body, 'Escape'));
    expect(modeOf(view.container)).toBe('off');
    await view.unmount();
  });

  it('does not hold a document-wide key listener while it is not full screen', async () => {
    const port = fakePort({ native: false });
    const view = await mount(<Probe port={port} />);
    await interact(() => pressKey(document.body, 'Escape'));
    expect(modeOf(view.container)).toBe('off');
    await view.unmount();
  });

  it('releases native full screen when the surface unmounts inside it', async () => {
    const port = fakePort();
    const view = await mount(<Probe port={port} />);
    await click(view.container, '[data-toggle]');
    await view.unmount();
    expect(port.calls).toEqual(['request', 'exit']);
  });

  it('does not exit a document it never took full screen when it unmounts', async () => {
    const port = fakePort({ native: false });
    const view = await mount(<Probe port={port} />);
    await click(view.container, '[data-toggle]');
    await view.unmount();
    expect(port.calls).toEqual([]);
  });
});

describe('FullscreenToggle', () => {
  it('says the same words, with a tooltip, in both states', async () => {
    const taps: number[] = [];
    const view = await mount(<FullscreenToggle active={false} onToggle={() => taps.push(1)} />);
    const button = must(view.container.querySelector('button'), 'button');
    expect(button.getAttribute('aria-label')).toBe('Full screen');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.title).toBe('Full screen');
    await interact(() => button.click());
    expect(taps).toEqual([1]);
    await view.render(<FullscreenToggle active onToggle={() => undefined} />);
    expect(button.getAttribute('aria-label')).toBe('Exit full screen');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.title).toContain('Esc');
    await view.unmount();
  });
});

describe('SurfaceFrame', () => {
  it('hands the host the controls, and fills the screen when asked', async () => {
    const view = await mount(
      <SurfaceFrame dataBrowser="app" hostsControls marker={<i data-marker="" />}>
        {controls => <div data-host="">{controls}</div>}
      </SurfaceFrame>,
    );
    const frame = must(view.container.querySelector('.fy-ws-frame'), 'frame');
    expect(frame.getAttribute('data-workspace-browser')).toBe('app');
    expect(view.container.querySelector('.fy-ws-bar')).toBeNull();
    expect(frame.querySelector('[data-host] [data-marker]')).not.toBeNull();
    expect(frame.hasAttribute('data-fullscreen')).toBe(false);
    await interact(() => must(frame.querySelector<HTMLElement>('button[aria-label="Full screen"]'), 'toggle').click());
    await interact(async () => undefined);
    expect(frame.hasAttribute('data-fullscreen')).toBe(true);
    await interact(() => pressKey(document.body, 'Escape'));
    expect(frame.hasAttribute('data-fullscreen')).toBe(false);
    await view.unmount();
  });

  it('draws one slim bar of its own only when the host has no row to put the controls in', async () => {
    const view = await mount(
      <SurfaceFrame dataBrowser="b1" hostsControls={false} marker={<i data-marker="" />}>
        {controls => <div data-host="">{controls === null ? 'nothing' : 'controls'}</div>}
      </SurfaceFrame>,
    );
    const bar = must(view.container.querySelector('.fy-ws-bar'), 'bar');
    expect(bar.querySelector('[data-marker]')).not.toBeNull();
    expect(bar.querySelector('button[aria-label="Full screen"]')).not.toBeNull();
    expect(must(view.container.querySelector('[data-host]'), 'host').textContent).toBe('nothing');
    await view.unmount();
  });
});

describe('browserFullscreenPort', () => {
  const restore: (() => void)[] = [];
  afterEach(() => {
    for (const undo of restore.splice(0)) undo();
  });
  const stub = (target: object, key: string, value: unknown): void => {
    const had = Object.hasOwn(target, key);
    const before = (target as Record<string, unknown>)[key];
    Object.defineProperty(target, key, { configurable: true, writable: true, value });
    restore.push(() => {
      if (had) Object.defineProperty(target, key, { configurable: true, writable: true, value: before });
      else delete (target as Record<string, unknown>)[key];
    });
  };
  const element = (shape: Record<string, unknown>): HTMLElement => {
    const el = document.createElement('div');
    for (const [key, value] of Object.entries(shape)) Object.defineProperty(el, key, { configurable: true, value });
    Object.defineProperty(el, 'requestFullscreen', { configurable: true, value: shape.requestFullscreen });
    return el;
  };

  it('can request only where the element has a way to', () => {
    expect(browserFullscreenPort.canRequest(element({}))).toBe(false);
    expect(browserFullscreenPort.canRequest(element({ requestFullscreen: async () => undefined }))).toBe(true);
    expect(browserFullscreenPort.canRequest(element({ webkitRequestFullscreen: () => undefined }))).toBe(true);
  });

  it('requests with the standard method, hides the browser chrome and locks Escape for the surface', async () => {
    const seen: unknown[] = [];
    const locked: unknown[] = [];
    stub(navigator, 'keyboard', { lock: async (keys: string[]) => void locked.push(keys), unlock: () => undefined });
    await browserFullscreenPort.request(
      element({
        requestFullscreen: async (options: unknown) => {
          seen.push(options);
        },
      }),
    );
    expect(seen).toEqual([{ navigationUI: 'hide' }]);
    expect(locked).toEqual([['Escape']]);
  });

  it('falls back to the prefixed request, and survives a browser with no keyboard lock', async () => {
    let called = 0;
    stub(navigator, 'keyboard', undefined);
    await browserFullscreenPort.request(
      element({
        webkitRequestFullscreen: () => {
          called += 1;
        },
      }),
    );
    expect(called).toBe(1);
  });

  it('survives a keyboard lock that is refused, or that throws', async () => {
    stub(navigator, 'keyboard', { lock: async () => Promise.reject(new Error('no')) });
    await browserFullscreenPort.request(element({ requestFullscreen: async () => undefined }));
    stub(navigator, 'keyboard', {
      lock: () => {
        throw new Error('sync');
      },
    });
    await browserFullscreenPort.request(element({ requestFullscreen: async () => undefined }));
  });

  it('exits with the standard or the prefixed method and releases the keyboard', async () => {
    const steps: string[] = [];
    stub(navigator, 'keyboard', { unlock: () => steps.push('unlock') });
    stub(document, 'exitFullscreen', async () => void steps.push('exit'));
    await browserFullscreenPort.exit();
    stub(document, 'exitFullscreen', undefined);
    stub(document, 'webkitExitFullscreen', () => void steps.push('webkit-exit'));
    await browserFullscreenPort.exit();
    expect(steps).toEqual(['unlock', 'exit', 'unlock', 'webkit-exit']);
  });

  it('names the full-screen element, standard or prefixed, and none when there is none', () => {
    const el = document.createElement('div');
    expect(browserFullscreenPort.current()).toBeNull();
    stub(document, 'fullscreenElement', el);
    expect(browserFullscreenPort.current()).toBe(el);
    stub(document, 'fullscreenElement', null);
    stub(document, 'webkitFullscreenElement', el);
    expect(browserFullscreenPort.current()).toBe(el);
  });

  it('hears both spellings of the change event, and stops listening', () => {
    let heard = 0;
    const stop = browserFullscreenPort.subscribe(() => {
      heard += 1;
    });
    document.dispatchEvent(new Event('fullscreenchange'));
    document.dispatchEvent(new Event('webkitfullscreenchange'));
    expect(heard).toBe(2);
    stop();
    document.dispatchEvent(new Event('fullscreenchange'));
    expect(heard).toBe(2);
  });
});
