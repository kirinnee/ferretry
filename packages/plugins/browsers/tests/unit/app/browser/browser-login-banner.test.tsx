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

  it('says the passkey is wanted after a refused read-back, with the shared confirm button, and shows no window', async () => {
    const asked: string[] = [];
    const view = await mount(
      <BrowserLoginBanner
        status={{ state: 'step-up-required' }}
        onClose={async () => closed}
        onConfirm={async () => {
          asked.push('confirm');
          return open;
        }}
      />,
    );
    const text = view.container.textContent ?? '';
    expect(text).toContain('Confirm it’s you to see the result');
    expect(text).not.toContain('unknown');
    // Nothing of the window, least of all its credential, is drawn before the daemon says yes.
    expect(text).not.toContain('temporary-password');
    expect(view.container.querySelector('[data-confirm-to-see]')).not.toBeNull();
    await interact(() => button(view.container, 'Confirm it’s you to see this').click());
    expect(asked).toEqual(['confirm']);
    await view.unmount();
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

  it('wears the danger tone for an error or unknown status, distinct from opening and closing', async () => {
    const tone = async (
      status: BrowserLoginSnapshot,
    ): Promise<{ readonly data: string | null; readonly cls: string }> => {
      const view = await mount(<BrowserLoginBanner status={status} onClose={async () => closed} />);
      const aside = must(view.container.querySelector('aside'), 'the status strip');
      const result = { data: aside.getAttribute('data-tone'), cls: aside.className };
      await view.unmount();
      return result;
    };
    const failure = await tone({ state: 'error', profilePrimed: false, error: 'no display' });
    expect(failure.data).toBe('err');
    expect(failure.cls).toContain('bg-err-bg');
    expect(failure.cls).toContain('text-err');
    const unknown = await tone({ state: 'unknown', error: 'network unavailable' });
    expect(unknown.data).toBe('err');
    expect(unknown.cls).toContain('border-err-border');
    const opening = await tone({ state: 'opening', profilePrimed: false });
    expect(opening.data).toBe('warn');
    expect(opening.cls).toContain('bg-warn-bg');
    expect(opening.cls).not.toContain('err');
    // The window itself is a warm, in-progress strip, never a failure.
    expect((await tone(open)).cls).not.toContain('err');
  });

  it('lets the reason wrap in full instead of truncating it', async () => {
    const reason = 'the human browser could not be reached over the tunnel';
    const view = await mount(
      <BrowserLoginBanner
        status={{ state: 'error', profilePrimed: false, error: reason }}
        onClose={async () => closed}
      />,
    );
    const text = must(view.container.querySelector('[role="status"] span span'), 'the reason');
    expect(text.textContent).toContain(reason);
    expect(text.className).not.toContain('truncate');
    await view.unmount();
  });

  it('keeps the countdown on its own unbreakable unit and the connection rows wrapping, with Copy always shown', async () => {
    const view = await mount(<BrowserLoginBanner status={open} onClose={async () => closed} now={NOW} />);
    const countdown = must(
      [...view.container.querySelectorAll('span')].find(span => span.textContent === 'closes in 1:01'),
      'the countdown unit',
    );
    expect(countdown.className).toContain('whitespace-nowrap');
    expect(countdown.parentElement?.className).not.toContain('truncate');
    const ssh = must(
      [...view.container.querySelectorAll('code')].find(code => code.textContent?.startsWith('ssh -N')),
      'the SSH command',
    );
    expect(ssh.className).toContain('overflow-wrap:anywhere');
    const box = must(ssh.parentElement?.parentElement, 'the details box');
    expect(box.className).not.toContain('overflow-auto');
    expect(box.className).not.toContain('max-h');
    expect(ssh.parentElement?.querySelector('button')?.className).toContain('shrink-0');
    await view.unmount();
  });

  it('runs its one-second timer only while the window is open', async () => {
    const realSet = globalThis.setInterval;
    const realClear = globalThis.clearInterval;
    const live = new Set<unknown>();
    globalThis.setInterval = ((handler: () => void, delay?: number) => {
      const id = realSet(handler, delay);
      if (delay === 1_000) live.add(id);
      return id;
    }) as typeof setInterval;
    globalThis.clearInterval = ((id?: Parameters<typeof clearInterval>[0]) => {
      live.delete(id);
      realClear(id);
    }) as typeof clearInterval;
    try {
      const shut = await mount(<BrowserLoginBanner status={closed} onClose={async () => closed} />);
      expect(live.size).toBe(0);
      await shut.unmount();
      const failed = await mount(
        <BrowserLoginBanner
          status={{ state: 'error', profilePrimed: false, error: 'x' }}
          onClose={async () => closed}
        />,
      );
      expect(live.size).toBe(0);
      await failed.unmount();
      const running = await mount(<BrowserLoginBanner status={open} onClose={async () => closed} />);
      expect(live.size).toBe(1);
      await running.unmount();
      expect(live.size).toBe(0);
    } finally {
      globalThis.setInterval = realSet;
      globalThis.clearInterval = realClear;
    }
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
