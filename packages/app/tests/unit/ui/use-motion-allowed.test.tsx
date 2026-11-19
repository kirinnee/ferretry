import { afterEach, describe, expect, test } from 'bun:test';
import { ensureDom, interact, type Mounted, mount } from '../../../src/testing/index.ts';
import { motionAllowed, useMotionAllowed } from '../../../src/ui/use-motion-allowed.ts';

ensureDom();
let view: Mounted | null = null;
const originalMatchMedia = globalThis.window?.matchMedia;

afterEach(async () => {
  await view?.unmount();
  view = null;
  document.documentElement.removeAttribute('data-motion');
  if (originalMatchMedia) window.matchMedia = originalMatchMedia;
});

function Probe() {
  return <span data-allowed={String(useMotionAllowed())} />;
}

/** A `matchMedia` whose reduce query answers `reduced`, and whose listener a test can fire. */
const fakeOsQuery = (reduced: boolean) => {
  const listeners = new Set<() => void>();
  let value = reduced;
  window.matchMedia = ((query: string) => ({
    matches: query.includes('prefers-reduced-motion') ? value : false,
    media: query,
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  })) as unknown as typeof window.matchMedia;
  return {
    flip: (next: boolean) => {
      value = next;
      for (const listener of listeners) listener();
    },
  };
};

const allowed = (): string | undefined =>
  view?.container.querySelector('span')?.getAttribute('data-allowed') ?? undefined;

describe('motionAllowed', () => {
  test('is true only when neither switch asks for stillness', () => {
    expect(motionAllowed(false, false)).toBe(true);
    expect(motionAllowed(true, false)).toBe(false);
    expect(motionAllowed(false, true)).toBe(false);
    expect(motionAllowed(true, true)).toBe(false);
  });
});

describe('useMotionAllowed', () => {
  test('allows motion when neither switch is on', async () => {
    fakeOsQuery(false);
    view = await mount(<Probe />);
    expect(allowed()).toBe('true');
  });

  test('stops under the OS query, and follows it live', async () => {
    const os = fakeOsQuery(true);
    view = await mount(<Probe />);
    expect(allowed()).toBe('false');
    await interact(() => os.flip(false));
    expect(allowed()).toBe('true');
  });

  test("stops under Ferretry's own Reduced setting, and follows it live", async () => {
    fakeOsQuery(false);
    document.documentElement.setAttribute('data-motion', 'reduced');
    view = await mount(<Probe />);
    expect(allowed()).toBe('false');
    await interact(async () => {
      document.documentElement.removeAttribute('data-motion');
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(allowed()).toBe('true');
  });

  test('still answers where there is no matchMedia at all', async () => {
    window.matchMedia = undefined as unknown as typeof window.matchMedia;
    view = await mount(<Probe />);
    expect(allowed()).toBe('true');
  });
});
