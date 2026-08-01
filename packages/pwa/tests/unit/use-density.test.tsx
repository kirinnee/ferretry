import { afterEach, describe, expect, it } from 'bun:test';

import { type ControlsStorage, DaemonControlsStore } from '../../src/lib/controls.ts';
import {
  DENSITY_OPTIONS,
  densityFromMatchMedia,
  densityFromMediaQuery,
  implicitDensity,
  readImplicitDensity,
  useDensity,
} from '../../src/hooks/use-density.ts';
import '../support/dom.ts';
import { interact, mount } from '../support/dom.ts';

const memoryStorage = (): ControlsStorage => {
  const values = new Map<string, string>();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
};

const Probe = ({ controls }: { readonly controls: DaemonControlsStore }) => {
  const density = useDensity(controls);
  return (
    <button
      type="button"
      data-density={density.density}
      data-explicit={String(density.explicit)}
      onClick={() => density.setDensity('minimal')}
    >
      density
    </button>
  );
};

afterEach(() => {
  document.documentElement.removeAttribute('data-density');
});

describe('density defaults', () => {
  it('uses compact only for a coarse no-hover primary pointer', () => {
    expect(implicitDensity(true)).toBe('compact');
    expect(implicitDensity(false)).toBe('full');
    expect(DENSITY_OPTIONS.map(option => option.id)).toEqual(['full', 'compact', 'minimal']);
    expect(['full', 'compact']).toContain(readImplicitDensity());
    expect(densityFromMediaQuery(() => true)).toBe('compact');
    expect(
      densityFromMediaQuery(() => {
        throw new Error('unavailable');
      }),
    ).toBe('full');
    expect(densityFromMatchMedia(undefined)).toBe('full');
    expect(densityFromMatchMedia(() => ({ matches: false }))).toBe('full');
  });
});

describe('useDensity', () => {
  it('keeps the implicit choice unpersisted, writes root metadata, and persists a reader choice device-wide', async () => {
    const controls = new DaemonControlsStore(memoryStorage());
    const view = await mount(<Probe controls={controls} />);
    const button = view.container.querySelector('button');

    expect(button?.getAttribute('data-explicit')).toBe('null');
    expect(document.documentElement.dataset.density).toBe(button?.getAttribute('data-density') ?? undefined);

    await interact(() => button?.click());
    expect(controls.snapshot().device.density).toBe('minimal');
    expect(document.documentElement.dataset.density).toBe('minimal');
    await view.unmount();
  });
});
