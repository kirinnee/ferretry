import { afterEach, describe, expect, it } from 'bun:test';
import { AppUpdatedToast } from '../../src/shell/app-updated-toast.tsx';
import { interact, type Mounted, mount, must } from '../support/dom.ts';

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

const storage = (seen: string | null) => ({ getItem: () => seen, setItem: () => undefined });

describe('AppUpdatedToast', () => {
  it('says the app updated once, and dismisses', async () => {
    mounted = await mount(<AppUpdatedToast storage={storage('4.28.0')} version="4.29.0" />);
    expect(mounted.container.textContent).toBe('Ferretry updated to 4.29.0.');
    const close = must(mounted.container.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]'), 'dismiss');
    await interact(() => close.click());
    expect(mounted.container.textContent).toBe('');
  });

  it('says nothing when the version did not move, and reads the browser by default', async () => {
    mounted = await mount(<AppUpdatedToast storage={storage('4.29.0')} version="4.29.0" />);
    expect(mounted.container.textContent).toBe('');
    await mounted.unmount();
    mounted = await mount(<AppUpdatedToast />);
    expect(mounted.container.textContent).toBe('');
  });
});
