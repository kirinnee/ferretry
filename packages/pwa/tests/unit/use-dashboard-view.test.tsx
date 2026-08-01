import { afterEach, describe, expect, it } from 'bun:test';
import { DASHBOARD_TABLE_MIN, narrowForWidth, useDashboardNarrow } from '../../src/hooks/use-dashboard-view.ts';
import { interact, mount } from '../support/dom.ts';

type MediaListener = () => void;

const listeners = new Set<MediaListener>();
const queries: string[] = [];
const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');

const setWidth = (width: number): void => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
};

const installMatchMedia = (): void => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => {
      queries.push(query);
      return {
        matches: false,
        addEventListener: (_: string, listener: MediaListener) => listeners.add(listener),
        removeEventListener: (_: string, listener: MediaListener) => listeners.delete(listener),
      };
    },
  });
};

const Probe = ({ breakpoint }: { breakpoint?: number }) => {
  const narrow = useDashboardNarrow(breakpoint);
  return <span data-narrow={String(narrow)} />;
};

const narrowAttribute = (container: HTMLElement): string | null =>
  container.querySelector('span')?.getAttribute('data-narrow') ?? null;

afterEach(() => {
  listeners.clear();
  queries.length = 0;
  if (originalMatchMedia) Object.defineProperty(window, 'matchMedia', originalMatchMedia);
  else Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'matchMedia');
});

describe('dashboard width projection', () => {
  it('crosses immediately below the documented table minimum', () => {
    expect(narrowForWidth(390)).toBe(true);
    expect(narrowForWidth(DASHBOARD_TABLE_MIN - 1)).toBe(true);
    expect(narrowForWidth(DASHBOARD_TABLE_MIN)).toBe(false);
    expect(narrowForWidth(1_440)).toBe(false);
    expect(narrowForWidth(699, 700)).toBe(true);
    expect(narrowForWidth(700, 700)).toBe(false);
  });

  it('reads the first viewport and follows only media-query crossings', async () => {
    installMatchMedia();
    setWidth(390);
    const mounted = await mount(<Probe />);

    expect(narrowAttribute(mounted.container)).toBe('true');
    expect(queries).toEqual(['(max-width: 899px)']);

    setWidth(1_440);
    await interact(() => {
      for (const listener of [...listeners]) listener();
    });
    expect(narrowAttribute(mounted.container)).toBe('false');

    await mounted.unmount();
    expect(listeners.size).toBe(0);
  });

  it('resubscribes when a caller supplies another crossing', async () => {
    installMatchMedia();
    setWidth(750);
    const mounted = await mount(<Probe breakpoint={800} />);
    expect(narrowAttribute(mounted.container)).toBe('true');
    expect(queries).toEqual(['(max-width: 799px)']);

    await mounted.render(<Probe breakpoint={700} />);
    expect(narrowAttribute(mounted.container)).toBe('false');
    expect(queries).toEqual(['(max-width: 799px)', '(max-width: 699px)']);

    await mounted.unmount();
  });

  it('keeps the initial viewport result when matchMedia is unavailable', async () => {
    Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'matchMedia');
    setWidth(390);
    const mounted = await mount(<Probe />);

    expect(narrowAttribute(mounted.container)).toBe('true');
    expect(listeners.size).toBe(0);

    await mounted.unmount();
  });
});
