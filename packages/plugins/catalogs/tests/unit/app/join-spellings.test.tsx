import { afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { deviceViewHarness, ensureDom, interact, type Mounted, mount, settleUntil } from '@ferretry/app/testing';
import { type ComponentType, Suspense } from 'react';
import half from '../../../app/index.ts';
import { SharedController } from '../../../app/features/shared/shared-controller.ts';
import { JOIN_PATH, JOIN_SCREEN_ID } from '../../../app/lib/routes.ts';

/**
 * R4-S1: WHEREVER THE ROUTER DRAWS THE JOIN SCREEN, THE SHARE LINK'S CODE LEAVES THE ADDRESS AND REACHES THAT SCREEN.
 * The half declares `/join`'s fragment (shell contract S3); the shell's real fragment taker reads that declaration at
 * each address the router draws `/join` at, and the half's real join view, drawn as that daemon-less screen, is followed
 * to its controller.
 */

ensureDom();

// The half's views chunk, loaded once up front: the first draw then waits on the join screen, not on module evaluation.
beforeAll(async () => {
  await import('../../../app/views/catalogs-views.tsx');
});

const FRAGMENT = '#v1;code=fy_share_x';

type DaemonlessFactory = (ports: unknown) => Record<string, ComponentType<{ navigate: (to: string) => void }>>;
const daemonless = (half as unknown as { shell: { daemonless: DaemonlessFactory } }).shell.daemonless;

const harnessAt = (href: string) =>
  deviceViewHarness({
    plugin: 'catalogs',
    fragments: half.shell.fragments ?? [],
    href,
    screens: [{ id: JOIN_SCREEN_ID, path: JOIN_PATH }],
  });

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  document.body.replaceChildren();
});

describe('R4-S1 a share link at any address the router draws the join screen at', () => {
  for (const address of ['/join', '/join/', '/app/join', '/app/join/', '/j%6Fin']) {
    it(`R4-S1 ${address}${FRAGMENT}: the code leaves the address, and the join screen gets it`, async () => {
      const begun: string[] = [];
      const begin = spyOn(SharedController.prototype, 'begin').mockImplementation(async fragment => {
        begun.push(fragment);
        return { kind: 'invalid', sentence: 'not a link' };
      });
      try {
        const harness = harnessAt(`${address}${FRAGMENT}`);
        // The code is off the address before anything is drawn.
        expect(harness.address()).toBe(address);
        const Join = daemonless({})[JOIN_SCREEN_ID] as ComponentType<{ navigate: (to: string) => void }>;
        view = await mount(
          <harness.Harness place="daemonless" screen={JOIN_SCREEN_ID}>
            <Suspense fallback={null}>
              <Join navigate={() => undefined} />
            </Suspense>
          </harness.Harness>,
        );
        await settleUntil(() => begun.length > 0, 'the join screen to begin', interact);
        expect(begun).toEqual([FRAGMENT]);
        expect(harness.address()).toBe(address);
      } finally {
        begin.mockRestore();
      }
    });
  }

  it('R4-S1 a fragment on a page that is not the join screen keeps it (no collateral strip)', () => {
    expect(harnessAt('/shared#anchor').address()).toBe('/shared#anchor');
    expect(harnessAt(`/join/elsewhere${FRAGMENT}`).address()).toBe('/join/elsewhere');
  });
});
