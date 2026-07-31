import { describe, expect, it } from 'bun:test';
import {
  BrowserLoginBanner,
  browserLoginRemaining,
  type BrowserLoginView,
} from '../../../src/features/browser/browser-login-banner.tsx';
import { render, run, runAsync } from '../../support/react.ts';

const closed: BrowserLoginView = { state: 'closed', profilePrimed: false };
const open: BrowserLoginView = {
  state: 'open',
  profilePrimed: false,
  expiresAt: '2099-01-01T00:00:00.000Z',
  connection: {
    host: '127.0.0.1',
    port: 5951,
    password: 'temporary-password',
    sshTunnel: 'ssh -N -L 5951:127.0.0.1:5951 reader@example.test',
  },
};

describe('BrowserLoginBanner', () => {
  it('does not mistake a closed window for an unavailable one', () => {
    const closedRenderer = render(<BrowserLoginBanner status={closed} onClose={async () => closed} />);
    const unknownRenderer = render(
      <BrowserLoginBanner status={{ state: 'unknown', error: 'network unavailable' }} onClose={async () => closed} />,
    );

    expect(closedRenderer.toJSON()).toBeNull();
    expect(JSON.stringify(unknownRenderer.toJSON())).toContain('Browser login status unknown');
  });

  it('keeps expiry, connection data, and explicit close choices visible', () => {
    const renderer = render(<BrowserLoginBanner status={open} onClose={async () => closed} />);
    const tree = JSON.stringify(renderer.toJSON());

    expect(browserLoginRemaining('2026-07-28T12:01:01.000Z', Date.parse('2026-07-28T12:00:00.000Z'))).toBe('1:01');
    expect(browserLoginRemaining('bad date')).toBe('expiry unknown');
    expect(tree).toContain('Browser login window open');
    expect(tree).toContain('127.0.0.1:5951');
    expect(tree).toContain('Connection details');
    expect(tree).toContain('overflow-auto');
  });

  it('reports whether the reader signed in and closes its action menu after completion', async () => {
    const calls: boolean[] = [];
    const renderer = render(
      <BrowserLoginBanner
        status={open}
        onClose={async primed => {
          calls.push(primed);
          return closed;
        }}
      />,
    );
    const closeToggle = renderer.root.findAllByType('button').find(button => button.props['aria-expanded'] === false);
    if (closeToggle === undefined) throw new Error('close toggle missing');

    run(() => closeToggle.props.onClick());
    const signedIn = renderer.root.findAllByProps({ 'data-variant': 'primary' })[0];
    if (signedIn === undefined) throw new Error('signed-in choice missing');
    await runAsync(async () => signedIn.props.onClick());

    expect(calls).toEqual([true]);
    expect(renderer.root.findAllByProps({ 'aria-label': 'Close browser login window' })).toHaveLength(0);
  });

  it('copies a live connection value and leaves the control usable when clipboard access is denied', async () => {
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const copied: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (value: string) => copied.push(value) },
    });
    try {
      const renderer = render(<BrowserLoginBanner status={open} onClose={async () => closed} />);
      const copyButtons = renderer.root.findAllByProps({ 'data-variant': 'ghost' });

      await runAsync(async () => copyButtons[0]?.props.onClick());
      expect(copied).toEqual(['127.0.0.1:5951']);
      expect(JSON.stringify(renderer.toJSON())).toContain('Copied');

      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async () => Promise.reject(new Error('blocked')) },
      });
      await runAsync(async () => copyButtons[1]?.props.onClick());
      expect(JSON.stringify(renderer.toJSON())).toContain('Copy');
    } finally {
      Object.defineProperty(navigator, 'clipboard', clipboardDescriptor ?? { configurable: true, value: undefined });
    }
  });
});
