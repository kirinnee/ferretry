import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { ensureDom, interact, mount, settleUntil } from '@ferretry/app/testing';
import { type ComponentType, Suspense } from 'react';
import half from '../../../app/index.ts';
import { SharedController } from '../../../app/features/shared/shared-controller.ts';

/**
 * R4-S1: WHEREVER THE ROUTER DRAWS THE JOIN SCREEN, THE SHARE LINK'S CODE LEAVES THE ADDRESS AND REACHES THAT SCREEN.
 * The half's own daemon-less factory is armed on a real (happy-dom) window at each address the shell's router draws
 * `/join` at, and its real join view is drawn; the code is followed to the join screen's controller.
 */

ensureDom();

const FRAGMENT = '#v1;code=fy_share_x';

type DaemonlessFactory = (ports: unknown) => Record<string, ComponentType<{ navigate: (to: string) => void }>>;
const daemonless = (half as unknown as { shell: { daemonless: DaemonlessFactory } }).shell.daemonless;

/** The `hashchange` listeners an arm left on the window, removed so the next case finds no stale hold listening. */
const armed: EventListener[] = [];
const addListener = window.addEventListener.bind(window);
window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: unknown) => {
  if (type === 'hashchange' && typeof listener === 'function') armed.push(listener);
  addListener(type, listener, options as AddEventListenerOptions);
}) as typeof window.addEventListener;

afterEach(() => {
  window.history.replaceState(null, '', '/');
  for (const listener of armed.splice(0)) window.removeEventListener('hashchange', listener);
  document.body.replaceChildren();
});

/** Arms the half at `address` and draws its join view, recording every link the join screen is handed. */
async function arrive(address: string) {
  window.history.replaceState({ fyEntry: 'e1' }, '', address);
  const lengthBefore = window.history.length;
  const push = spyOn(window.history, 'pushState');
  const replace = spyOn(window.history, 'replaceState');
  const begun: string[] = [];
  const begin = spyOn(SharedController.prototype, 'begin').mockImplementation(async fragment => {
    begun.push(fragment);
    return { kind: 'invalid', sentence: 'not a link' };
  });
  try {
    const Join = daemonless({}).join as ComponentType<{ navigate: (to: string) => void }>;
    // The code is off the address before anything is drawn.
    const hashAtArm = window.location.hash;
    const mounted = await mount(
      <Suspense fallback={null}>
        <Join navigate={() => undefined} />
      </Suspense>,
    );
    await settleUntil(() => begun.length > 0, 'the join screen to begin', interact);
    const writes = [...push.mock.calls, ...replace.mock.calls].map(call => String(call[2] ?? ''));
    await mounted.unmount();
    return { hashAtArm, lengthBefore, pushes: push.mock.calls.length, writes, begun };
  } finally {
    push.mockRestore();
    replace.mockRestore();
    begin.mockRestore();
  }
}

describe('R4-S1 a share link at any address the router draws the join screen at', () => {
  for (const address of ['/join', '/join/', '/app/join', '/app/join/', '/j%6Fin']) {
    it(`R4-S1 ${address}${FRAGMENT}: the code leaves the address and the history entry, and the join screen gets it`, async () => {
      const arrived = await arrive(`${address}${FRAGMENT}`);
      expect(arrived.hashAtArm).toBe('');
      expect(window.location.hash).toBe('');
      expect(window.history.length).toBe(arrived.lengthBefore);
      expect(arrived.pushes).toBe(0);
      expect(arrived.writes).toEqual([address]);
      expect(arrived.begun).toEqual([FRAGMENT]);
    });
  }

  it('R4-S1 a fragment on a page that is not the join screen keeps it (no collateral strip)', async () => {
    window.history.replaceState(null, '', '/shared#anchor');
    const replace = spyOn(window.history, 'replaceState');
    try {
      daemonless({});
      expect(window.location.hash).toBe('#anchor');
      expect(replace).not.toHaveBeenCalled();
    } finally {
      replace.mockRestore();
    }
  });
});
