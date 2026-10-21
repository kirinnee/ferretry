import { describe, expect, it } from 'bun:test';
import type { BrowserStatus } from '@ferretry/protocol';
import { BrowserChallengeBanner, shownChallenge } from '../../../src/features/browser/browser-challenge-banner.tsx';
import { render } from '../../support/react.ts';

const base = {
  sessionId: 's1',
  viewport: { width: 1280, height: 800 },
  viewers: 1,
  persistentProfile: true,
  idleTimeoutSeconds: 900,
  capacity: { running: 1, maximum: 3 },
} as const;

const running = (challenged: boolean): BrowserStatus => ({
  ...base,
  state: 'running',
  url: 'https://shop.example/',
  title: 'Just a moment...',
  activePageId: 'pg-2',
  pages: [
    { id: 'pg-1', url: 'https://other.example/', title: 'Other', challenge: { provider: 'hcaptcha' } },
    {
      id: 'pg-2',
      url: 'https://shop.example/',
      title: 'Just a moment...',
      ...(challenged ? { challenge: { provider: 'cloudflare' as const } } : {}),
    },
  ],
  pageState: 'ready',
  canGoBack: false,
  canGoForward: false,
});

describe('shownChallenge', () => {
  it('reads the challenge of the page on screen, and only that page', () => {
    expect(shownChallenge(running(true))).toEqual({ provider: 'cloudflare' });
    expect(shownChallenge(running(false))).toBeNull();
    expect(shownChallenge(null)).toBeNull();
    expect(shownChallenge({ ...base, state: 'stopped', pages: [] })).toBeNull();
    expect(shownChallenge({ ...base, state: 'running', pages: [] })).toBeNull();
  });
});

describe('BrowserChallengeBanner', () => {
  it('names who is asking and hands the check to the person', () => {
    const tree = JSON.stringify(render(<BrowserChallengeBanner challenge={{ provider: 'cloudflare' }} />).toJSON());

    expect(tree).toContain('This page appears to be asking you to prove you’re a person');
    expect(tree).toContain(' (Cloudflare)');
    expect(tree).toContain('take the page over, solve it yourself, then hand it back');
    expect(tree).toContain('Real window');
  });

  it('names nobody when the check is not one it knows by name', () => {
    const tree = JSON.stringify(render(<BrowserChallengeBanner challenge={{ provider: 'other' }} />).toJSON());

    expect(tree).toContain('prove you’re a person');
    expect(tree).not.toMatch(/ \(\w/);
  });
});
