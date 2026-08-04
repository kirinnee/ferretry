import { afterEach, describe, expect, it } from 'bun:test';
import {
  DRAWER_MAX,
  type LayoutMode,
  layoutModeForWidth,
  RAIL_MAX,
  useLayoutMode,
} from '../../src/hooks/use-layout-mode.ts';
import { interact, mount } from '../support/dom.ts';

type MediaListener = () => void;

const listeners = new Set<MediaListener>();
const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
const originalInnerWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth');

const setWidth = (width: number): void => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
};

/** A matchMedia whose crossings this suite fires by hand. */
const installMatchMedia = (): void => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: () => ({
      matches: false,
      addEventListener: (_: string, listener: MediaListener) => listeners.add(listener),
      removeEventListener: (_: string, listener: MediaListener) => listeners.delete(listener),
    }),
  });
};

const Probe = ({ seen }: { seen: LayoutMode[] }) => {
  const mode = useLayoutMode();
  seen.push(mode);
  return <span data-mode={mode} />;
};

const modeOf = (container: HTMLElement): string | null =>
  container.querySelector('span')?.getAttribute('data-mode') ?? null;

afterEach(() => {
  listeners.clear();
  if (originalMatchMedia) Object.defineProperty(window, 'matchMedia', originalMatchMedia);
  else Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'matchMedia');
  if (originalInnerWidth) Object.defineProperty(window, 'innerWidth', originalInnerWidth);
  else Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'innerWidth');
});

describe('layoutModeForWidth', () => {
  it('separates the three regimes at their documented crossings', () => {
    expect(layoutModeForWidth(390)).toBe('drawer');
    expect(layoutModeForWidth(DRAWER_MAX - 1)).toBe('drawer');
    expect(layoutModeForWidth(DRAWER_MAX)).toBe('rail');
    expect(layoutModeForWidth(RAIL_MAX - 1)).toBe('rail');
    expect(layoutModeForWidth(RAIL_MAX)).toBe('full');
    expect(layoutModeForWidth(1440)).toBe('full');
  });
});

describe('useLayoutMode', () => {
  it('reports the regime the viewport is already in on the first render', async () => {
    installMatchMedia();
    setWidth(390);
    const seen: LayoutMode[] = [];
    const mounted = await mount(<Probe seen={seen} />);

    expect(seen[0]).toBe('drawer');
    expect(modeOf(mounted.container)).toBe('drawer');

    await mounted.unmount();
  });

  it('follows a crossing rather than every pixel of a window drag', async () => {
    installMatchMedia();
    setWidth(1440);
    const seen: LayoutMode[] = [];
    const mounted = await mount(<Probe seen={seen} />);

    expect(modeOf(mounted.container)).toBe('full');

    setWidth(900);
    await interact(() => {
      for (const listener of [...listeners]) listener();
    });

    expect(modeOf(mounted.container)).toBe('rail');

    setWidth(390);
    await interact(() => {
      for (const listener of [...listeners]) listener();
    });

    expect(modeOf(mounted.container)).toBe('drawer');

    await mounted.unmount();

    // Both queries are unsubscribed, so a later crossing cannot touch state on
    // an unmounted tree.
    expect(listeners.size).toBe(0);
  });

  it('stays on the widest regime where matchMedia is unavailable', async () => {
    Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'matchMedia');
    setWidth(390);
    const seen: LayoutMode[] = [];
    const mounted = await mount(<Probe seen={seen} />);

    // The initial read still uses innerWidth; only the subscription is skipped.
    expect(modeOf(mounted.container)).toBe('drawer');
    expect(listeners.size).toBe(0);

    await mounted.unmount();
  });
});
