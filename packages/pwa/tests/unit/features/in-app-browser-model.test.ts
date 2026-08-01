import { describe, expect, it } from 'bun:test';
import {
  browserDestination,
  isLoopbackHostname,
  shouldOpenInApp,
} from '../../../src/features/browser/in-app-browser-model.ts';

const activation = (overrides: Partial<Parameters<typeof shouldOpenInApp>[0]> = {}) => ({
  defaultPrevented: false,
  button: 0,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...overrides,
});

describe('loopback hostnames', () => {
  it('names every form of "this device", including a bracketed IPv6 literal', () => {
    for (const host of ['localhost', 'API.localhost', '0.0.0.0', '::', '::1', '[::1]', '127.0.0.1', '127.10.0.9'])
      expect(isLoopbackHostname(host)).toBe(true);
  });

  it('leaves ordinary hosts alone', () => {
    for (const host of ['example.test', 'localhost.evil.test', '128.0.0.1', '1.2.3.4'])
      expect(isLoopbackHostname(host)).toBe(false);
  });
});

describe('classifying a link', () => {
  it('refuses anything that is not http(s), and anything unparseable', () => {
    expect(browserDestination(undefined)).toBeNull();
    expect(browserDestination('   ')).toBeNull();
    expect(browserDestination('not a url')).toBeNull();
    expect(browserDestination('javascript:alert(1)')).toBeNull();
    expect(browserDestination('mailto:someone@example.test')).toBeNull();
    expect(browserDestination('file:///etc/passwd')).toBeNull();
  });

  it('calls a link same-origin only against a matching base', () => {
    expect(browserDestination('/docs', 'https://app.example.test/session')).toEqual({
      href: 'https://app.example.test/docs',
      hostname: 'app.example.test',
      scope: 'same-origin',
    });
    expect(browserDestination('https://other.example.test/x', 'https://app.example.test/')?.scope).toBe('cross-origin');
  });

  it('marks a loopback target as the reader’s own device, not the agent’s machine', () => {
    expect(browserDestination('http://localhost:5173/', 'https://app.example.test/')).toEqual({
      href: 'http://localhost:5173/',
      hostname: 'localhost',
      scope: 'device-loopback',
    });
    // Served FROM loopback, a loopback link is just same-origin browsing.
    expect(browserDestination('http://127.0.0.1:5173/x', 'http://127.0.0.1:5173/')?.scope).toBe('same-origin');
    expect(browserDestination('http://localhost:9/x', 'http://127.0.0.1:5173/')?.scope).toBe('cross-origin');
  });

  it('refuses everything once the caller’s base is malformed', () => {
    // `new URL(href, base)` parses the base first, so even an absolute target
    // is rejected. The classifier's second, defensive parse of the base can
    // therefore never be the thing that fails.
    expect(browserDestination('https://example.test/a', 'not a base')).toBeNull();
  });

  it('takes an absolute url with no base at all', () => {
    expect(browserDestination('https://example.test/a')?.scope).toBe('cross-origin');
  });
});

describe('deciding whether to intercept a click', () => {
  const destination = { href: 'https://example.test/', hostname: 'example.test', scope: 'cross-origin' } as const;

  it('takes an ordinary primary tap', () => {
    expect(shouldOpenInApp(activation(), destination, undefined)).toBe(true);
  });

  it('leaves new-tab and non-primary gestures to the browser', () => {
    expect(shouldOpenInApp(activation({ metaKey: true }), destination, undefined)).toBe(false);
    expect(shouldOpenInApp(activation({ ctrlKey: true }), destination, undefined)).toBe(false);
    expect(shouldOpenInApp(activation({ shiftKey: true }), destination, undefined)).toBe(false);
    expect(shouldOpenInApp(activation({ altKey: true }), destination, undefined)).toBe(false);
    expect(shouldOpenInApp(activation({ button: 1 }), destination, undefined)).toBe(false);
    expect(shouldOpenInApp(activation({ defaultPrevented: true }), destination, undefined)).toBe(false);
  });

  it('never intercepts a download, and never a link it could not classify', () => {
    expect(shouldOpenInApp(activation(), destination, 'report.pdf')).toBe(false);
    expect(shouldOpenInApp(activation(), null, undefined)).toBe(false);
  });
});
