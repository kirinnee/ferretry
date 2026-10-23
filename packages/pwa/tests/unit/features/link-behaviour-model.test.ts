import { describe, expect, it } from 'bun:test';
import type { BrowserActivation } from '../../../src/features/browser/in-app-browser-model.ts';
import {
  decideLinkAction,
  isIosStandalone,
  type LinkDecisionInput,
  safariHref,
} from '../../../src/features/browser/link-behaviour-model.ts';
import type { OpenLinksIn } from '../../../src/lib/controls.ts';

const PRIMARY: BrowserActivation = {
  defaultPrevented: false,
  button: 0,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
};

/** Every way a click asks the browser for its own behaviour. */
const MODIFIED: readonly (readonly [string, Partial<BrowserActivation>])[] = [
  ['Cmd-click', { metaKey: true }],
  ['Ctrl-click', { ctrlKey: true }],
  ['Shift-click', { shiftKey: true }],
  ['Alt-click', { altKey: true }],
  ['a middle click', { button: 1 }],
  ['a click another handler already took', { defaultPrevented: true }],
];

const SETTINGS: readonly OpenLinksIn[] = ['browser', 'panel', 'computer'];
const PLATFORMS: readonly boolean[] = [false, true];

const decide = (overrides: Partial<LinkDecisionInput>) =>
  decideLinkAction({
    setting: 'browser',
    activation: PRIMARY,
    href: 'https://docs.example.test/a?b=1#c',
    iosStandalone: false,
    ...overrides,
  });

describe('decideLinkAction', () => {
  it('leaves an ordinary tap to the browser’s new tab by default, outside the iOS app', () => {
    expect(decide({})).toEqual({ kind: 'native' });
  });

  it('hands an ordinary tap to the real Safari app from the installed iOS app, with a new tab as the fallback', () => {
    expect(decide({ iosStandalone: true })).toEqual({
      kind: 'safari',
      href: 'x-safari-https://docs.example.test/a?b=1#c',
      fallback: 'https://docs.example.test/a?b=1#c',
    });
    expect(decide({ iosStandalone: true, href: 'http://plain.example.test/' })).toEqual({
      kind: 'safari',
      href: 'x-safari-http://plain.example.test/',
      fallback: 'http://plain.example.test/',
    });
  });

  it('opens the side panel on an ordinary tap when it is chosen, on every platform', () => {
    for (const iosStandalone of PLATFORMS) {
      const action = decide({ setting: 'panel', iosStandalone });
      expect(action.kind).toBe('panel');
      if (action.kind === 'panel')
        expect(action.destination).toEqual({
          href: 'https://docs.example.test/a?b=1#c',
          hostname: 'docs.example.test',
          scope: 'cross-origin',
        });
    }
  });

  it('hands an ordinary tap to the daemon on this computer when it is chosen and one is connected', () => {
    for (const iosStandalone of PLATFORMS)
      expect(decide({ setting: 'computer', computerAvailable: true, iosStandalone })).toEqual({
        kind: 'computer',
        href: 'https://docs.example.test/a?b=1#c',
      });
  });

  it('behaves as the browser does when the computer is chosen but no local daemon is connected', () => {
    for (const computerAvailable of [false, undefined]) {
      expect(decide({ setting: 'computer', computerAvailable })).toEqual({ kind: 'native' });
      expect(decide({ setting: 'computer', computerAvailable, iosStandalone: true })).toEqual(
        decide({ setting: 'browser', iosStandalone: true }),
      );
    }
  });

  it('never takes the computer hand-off for the other settings, even when a local daemon is connected', () => {
    expect(decide({ setting: 'browser', computerAvailable: true })).toEqual({ kind: 'native' });
    expect(decide({ setting: 'panel', computerAvailable: true }).kind).toBe('panel');
  });

  it('keeps Cmd/Ctrl-click, other modifiers, downloads and non-HTTP schemes native for the computer hand-off', () => {
    const local = { setting: 'computer', computerAvailable: true } as const;
    for (const [, modifier] of MODIFIED)
      expect(decide({ ...local, activation: { ...PRIMARY, ...modifier } })).toEqual({ kind: 'native' });
    expect(decide({ ...local, download: true })).toEqual({ kind: 'native' });
    expect(decide({ ...local, href: 'mailto:someone@example.test' })).toEqual({ kind: 'native' });
  });

  it('keeps every modified click native, whatever the setting and the platform', () => {
    for (const setting of SETTINGS)
      for (const iosStandalone of PLATFORMS)
        for (const [, modifier] of MODIFIED)
          expect(decide({ setting, iosStandalone, activation: { ...PRIMARY, ...modifier } })).toEqual({
            kind: 'native',
          });
  });

  it('keeps every scheme but HTTP(S) native, whatever the setting and the platform', () => {
    const others = [
      'mailto:someone@example.test',
      'blob:https://app.example.test/1234',
      'tel:+15550100',
      'ftp://x.test/',
    ];
    for (const setting of SETTINGS)
      for (const iosStandalone of PLATFORMS) {
        for (const href of others) expect(decide({ setting, iosStandalone, href })).toEqual({ kind: 'native' });
        expect(decide({ setting, iosStandalone, href: undefined })).toEqual({ kind: 'native' });
        expect(decide({ setting, iosStandalone, href: '   ' })).toEqual({ kind: 'native' });
        expect(decide({ setting, iosStandalone, href: 'not a url' })).toEqual({ kind: 'native' });
      }
  });

  it('keeps a download native, whatever the setting and the platform', () => {
    for (const setting of SETTINGS)
      for (const iosStandalone of PLATFORMS) {
        expect(decide({ setting, iosStandalone, download: 'report.pdf' })).toEqual({ kind: 'native' });
        expect(decide({ setting, iosStandalone, download: true })).toEqual({ kind: 'native' });
      }
  });

  it('resolves a relative link against the document before deciding', () => {
    const action = decide({ setting: 'panel', href: '/docs', baseHref: 'https://app.example.test/d/x' });
    expect(action.kind === 'panel' && action.destination).toEqual({
      href: 'https://app.example.test/docs',
      hostname: 'app.example.test',
      scope: 'same-origin',
    });
    expect(decide({ iosStandalone: true, href: 'docs', baseHref: 'https://app.example.test/d/' })).toEqual({
      kind: 'safari',
      href: 'x-safari-https://app.example.test/d/docs',
      fallback: 'https://app.example.test/d/docs',
    });
  });
});

describe('safariHref', () => {
  it('prefixes only an HTTP(S) address', () => {
    expect(safariHref('https://example.test/')).toBe('x-safari-https://example.test/');
    expect(safariHref('http://example.test/')).toBe('x-safari-http://example.test/');
    expect(safariHref('mailto:a@example.test')).toBeNull();
    expect(safariHref('x-safari-https://example.test/')).toBeNull();
  });
});

describe('isIosStandalone', () => {
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)';
  const IPAD_AS_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';
  const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129';

  it('is the installed app on an iPhone, by either signal', () => {
    expect(
      isIosStandalone({ userAgent: IPHONE, maxTouchPoints: 5, navigatorStandalone: true, standaloneDisplay: false }),
    ).toBe(true);
    expect(isIosStandalone({ userAgent: IPHONE, maxTouchPoints: 5, standaloneDisplay: true })).toBe(true);
  });

  it('is the installed app on an iPad that announces itself as a Mac', () => {
    expect(
      isIosStandalone({
        userAgent: IPAD_AS_MAC,
        maxTouchPoints: 5,
        navigatorStandalone: true,
        standaloneDisplay: true,
      }),
    ).toBe(true);
  });

  it('is not Safari itself, a Mac, or an installed app on Android', () => {
    expect(
      isIosStandalone({ userAgent: IPHONE, maxTouchPoints: 5, navigatorStandalone: false, standaloneDisplay: false }),
    ).toBe(false);
    expect(isIosStandalone({ userAgent: IPAD_AS_MAC, maxTouchPoints: 0, standaloneDisplay: true })).toBe(false);
    expect(isIosStandalone({ userAgent: ANDROID, maxTouchPoints: 5, standaloneDisplay: true })).toBe(false);
  });
});
