/** Ported from v4's `browser-login-banner.test.tsx`, drawn in a real DOM. */
import { describe, expect, it } from 'bun:test';
import { interact, mount, must } from '@ferretry/app/testing';
import { BrowserLoginBanner, browserLoginRemaining } from '../../../../app/features/browser/browser-login-banner.tsx';
import type { BrowserLoginSnapshot } from '../../../../app/lib/browser-login.ts';
import { BrowserLoginStatusSchema } from '../../../../contract/index.ts';
import { withDocument } from '../../../support/app/dom.ts';

await withDocument();

const closed: BrowserLoginSnapshot = { state: 'closed', profilePrimed: false };
const open: BrowserLoginSnapshot = BrowserLoginStatusSchema.parse({
  state: 'open',
  profilePrimed: false,
  openedAt: '2099-01-01T00:00:00.000Z',
  expiresAt: '2099-01-01T00:10:00.000Z',
  connection: {
    host: '127.0.0.1',
    port: 5951,
    password: 'temporary-password',
    sshTunnel: 'ssh -N -L 5951:127.0.0.1:5951 reader@example.test',
  },
});
const NOW = Date.parse('2099-01-01T00:08:59.000Z');

const button = (container: HTMLElement, text: string): HTMLButtonElement =>
  must(
    [...container.querySelectorAll('button')].find(candidate => candidate.textContent?.trim() === text),
    `button named “${text}”`,
  );

describe('browserLoginRemaining', () => {
  it('counts down as m:ss, never below zero, and says so when the time cannot be read', () => {
    expect(browserLoginRemaining('2026-07-28T12:01:01.000Z', Date.parse('2026-07-28T12:00:00.000Z'))).toBe('1:01');
    expect(browserLoginRemaining('2026-07-28T11:00:00.000Z', Date.parse('2026-07-28T12:00:00.000Z'))).toBe('0:00');
    expect(browserLoginRemaining('bad date')).toBe('expiry unknown');
    expect(browserLoginRemaining(undefined)).toBe('expiry unknown');
    expect(browserLoginRemaining('2099-01-01T00:00:00.000Z')).toMatch(/^\d+:\d\d$/);
  });
});

describe('BrowserLoginBanner', () => {
  it('draws nothing for a window that is closed or not read yet', async () => {
    const unread = await mount(<BrowserLoginBanner status={null} onClose={async () => closed} />);
    expect(unread.container.innerHTML).toBe('');
    await unread.unmount();
    const shut = await mount(<BrowserLoginBanner status={closed} onClose={async () => closed} />);
    expect(shut.container.innerHTML).toBe('');
    await shut.unmount();
  });

  it('does not mistake a failed read for a closed window', async () => {
    const unknown = await mount(
      <BrowserLoginBanner status={{ state: 'unknown', error: 'network unavailable' }} onClose={async () => closed} />,
    );
    expect(unknown.container.querySelector('[role="status"]')?.textContent).toContain(
      'Browser login status unknown · network unavailable',
    );
    await unknown.unmount();
  });

  it('says opening, closing and error states in words, and an error with its reason', async () => {
    const words = async (status: BrowserLoginSnapshot): Promise<string> => {
      const view = await mount(<BrowserLoginBanner status={status} onClose={async () => closed} />);
      const text = view.container.querySelector('[role="status"]')?.textContent ?? '';
      await view.unmount();
      return text;
    };
    expect(await words({ state: 'opening', profilePrimed: false })).toBe('Browser login opening');
    expect(
      await words(
        BrowserLoginStatusSchema.parse({
          state: 'closing',
          profilePrimed: false,
          openedAt: '2099-01-01T00:00:00.000Z',
          expiresAt: '2099-01-01T00:10:00.000Z',
        }),
      ),
    ).toBe('Browser login closing');
    expect(await words({ state: 'error', profilePrimed: false })).toBe('Browser login error');
    expect(await words({ state: 'error', profilePrimed: false, error: 'no display' })).toBe(
      'Browser login error · no display',
    );
  });

  it('keeps the expiry, the close choices and the connection details for an open window', async () => {
    const view = await mount(<BrowserLoginBanner status={open} onClose={async () => closed} now={NOW} />);
    const text = view.container.textContent ?? '';
    expect(text).toContain('Browser login window open · closes in 1:01');
    expect(text).toContain('Connection details');
    expect(text).toContain('127.0.0.1:5951');
    // The credential is not in the live region a screen reader announces: the open state has no `role="status"`.
    expect(view.container.querySelector('[role="status"]')).toBeNull();
    await view.unmount();
  });

  it('ticks its own clock when none is given, and stops on unmount', async () => {
    const view = await mount(<BrowserLoginBanner status={open} onClose={async () => closed} />);
    expect(view.container.textContent).toMatch(/closes in \d+:\d\d/);
    await view.unmount();
  });

  it('reports whether the reader signed in, then folds its menu away', async () => {
    const calls: boolean[] = [];
    const view = await mount(
      <BrowserLoginBanner
        status={open}
        now={NOW}
        onClose={async primed => {
          calls.push(primed);
          return closed;
        }}
      />,
    );
    expect(view.container.querySelector('fieldset')).toBeNull();
    await interact(() => button(view.container, 'Close').click());
    expect(view.container.querySelector('fieldset')).not.toBeNull();
    await interact(() => button(view.container, 'Close — I signed in').click());
    expect(calls).toEqual([true]);
    expect(view.container.querySelector('fieldset')).toBeNull();

    await interact(() => button(view.container, 'Close').click());
    await interact(() => button(view.container, 'Close — not signed in').click());
    expect(calls).toEqual([true, false]);
    await view.unmount();
  });

  it('copies a connection value, and stays usable when the clipboard is denied', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const copied: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          copied.push(value);
        },
      },
    });
    try {
      const view = await mount(<BrowserLoginBanner status={open} onClose={async () => closed} now={NOW} />);
      const copies = [...view.container.querySelectorAll('button')].filter(candidate =>
        candidate.textContent?.includes('Copy'),
      );
      expect(copies).toHaveLength(3);
      await interact(() => copies[1]?.click());
      expect(copied).toEqual(['temporary-password']);
      expect(copies[1]?.textContent).toContain('Copied');

      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: () => Promise.reject(new Error('blocked')) },
      });
      await interact(() => copies[0]?.click());
      expect(copies[0]?.textContent).toContain('Copy');
      expect(copies[0]?.textContent).not.toContain('Copied');
      await view.unmount();
    } finally {
      Object.defineProperty(navigator, 'clipboard', descriptor ?? { configurable: true, value: undefined });
    }
  });
});
