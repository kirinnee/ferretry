import { beforeEach, describe, expect, it } from 'bun:test';
import type { BrowserDestination } from '../../../src/features/browser/in-app-browser-model.ts';
import {
  browserEngineForSession,
  browserSessionMemory,
  createPreviewHistory,
  currentBrowserUrl,
  currentPreviewEntry,
  movePreviewHistory,
  previewCanGoBack,
  previewCanGoForward,
  pushPreviewHistory,
  rememberBrowserEngine,
  rememberBrowserIncoming,
  resetBrowserSurfaceSessions,
  resolveBrowserAddress,
  shouldAdoptIncomingLink,
} from '../../../src/features/browser/unified-browser-model.ts';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../../src/lib/daemon-scope.ts';

const daemon = daemonConnection({
  daemonId: 'browser-daemon',
  baseUrl: 'https://browser.example.test',
  deviceToken: 'browser-token',
});
const other = daemonConnection({
  daemonId: 'other-daemon',
  baseUrl: 'https://other.example.test',
  deviceToken: 'other-token',
});
const scope = daemonSessionScope(daemon, 'shared-session-id');
const otherScope = daemonSessionScope(other, 'shared-session-id');

const APP_BASE = 'https://app.example.test/session/abc';

const destination = (href: string): BrowserDestination => ({
  href,
  hostname: new URL(href).hostname,
  scope: 'cross-origin',
});

beforeEach(resetBrowserSurfaceSessions);

describe('the remembered engine', () => {
  it('starts on the process-free preview', () => {
    expect(browserEngineForSession(scope)).toBe('preview');
  });

  it('never carries one daemon’s engine choice onto another daemon', () => {
    rememberBrowserEngine(scope, 'remote');
    expect(browserEngineForSession(scope)).toBe('remote');
    // The remote engine is a Chrome process on ONE daemon; the other has none.
    expect(browserEngineForSession(otherScope)).toBe('preview');
    resetBrowserSurfaceSessions();
    expect(browserEngineForSession(scope)).toBe('preview');
  });

  it('has nothing to remember until a surface has been there', () => {
    expect(browserSessionMemory(scope)).toBeNull();
    rememberBrowserEngine(scope, 'remote');
    expect(browserSessionMemory(scope)).toEqual({ engine: 'remote', lastIncoming: null });
    expect(browserSessionMemory(otherScope)).toBeNull();
  });

  it('keeps the engine and the incoming link independent of each other', () => {
    const first = destination('https://a.example.test/');
    rememberBrowserIncoming(scope, first);
    // Writing the link may not silently reset the engine to the default…
    expect(browserSessionMemory(scope)).toEqual({ engine: 'preview', lastIncoming: first });
    rememberBrowserEngine(scope, 'remote');
    // …and writing the engine may not forget the link.
    expect(browserSessionMemory(scope)).toEqual({ engine: 'remote', lastIncoming: first });
    rememberBrowserIncoming(scope, null);
    expect(browserSessionMemory(scope)).toEqual({ engine: 'remote', lastIncoming: null });
    expect(browserSessionMemory(otherScope)).toBeNull();
  });
});

describe('the incoming-link remount policy', () => {
  const stored = destination('https://a.example.test/');

  it('reattaches rather than re-opening when nothing changed while it was gone', () => {
    expect(shouldAdoptIncomingLink({ engine: 'remote', lastIncoming: stored }, stored)).toBe(false);
    // A first mount has no memory to compare against: keep the reader's place.
    expect(shouldAdoptIncomingLink(null, stored)).toBe(false);
    // No link at all is nothing to adopt.
    expect(shouldAdoptIncomingLink({ engine: 'remote', lastIncoming: stored }, null)).toBe(false);
    expect(shouldAdoptIncomingLink({ engine: 'remote', lastIncoming: stored }, undefined)).toBe(false);
  });

  it('adopts a link the app changed while the surface was absent', () => {
    expect(shouldAdoptIncomingLink({ engine: 'remote', lastIncoming: null }, stored)).toBe(true);
    // Identity, not href: a fresh tap of the same address is a new request.
    expect(
      shouldAdoptIncomingLink({ engine: 'remote', lastIncoming: stored }, destination('https://a.example.test/')),
    ).toBe(true);
  });
});

describe('the engine-agnostic toolbar', () => {
  const first = destination('https://a.example.test/');
  const second = destination('https://b.example.test/');

  it('reports where the preview engine can still go', () => {
    const empty = createPreviewHistory();
    expect(previewCanGoBack(empty)).toBe(false);
    expect(previewCanGoForward(empty)).toBe(false);

    const one = createPreviewHistory(first);
    expect(previewCanGoBack(one)).toBe(false);
    expect(previewCanGoForward(one)).toBe(false);

    const two = pushPreviewHistory(one, second);
    expect(previewCanGoBack(two)).toBe(true);
    expect(previewCanGoForward(two)).toBe(false);
    expect(previewCanGoForward(movePreviewHistory(two, -1))).toBe(true);
  });

  it('shows the selected engine’s address, falling back rather than blanking', () => {
    expect(currentBrowserUrl('preview', null, null)).toBe('');
    expect(currentBrowserUrl('preview', first, { url: 'https://chrome.example.test/', title: '' })).toBe(
      'https://a.example.test/',
    );
    expect(currentBrowserUrl('remote', first, { url: 'https://chrome.example.test/', title: '' })).toBe(
      'https://chrome.example.test/',
    );
    // Chrome has not reported a page yet: the preview position is better than
    // an empty bar, and an empty bar is better than an invented address.
    expect(currentBrowserUrl('remote', first, null)).toBe('https://a.example.test/');
    expect(currentBrowserUrl('remote', null, null)).toBe('');
  });
});

describe('the address bar', () => {
  it('asks for something rather than resolving nothing', () => {
    expect(resolveBrowserAddress('   ')).toEqual({ kind: 'error', message: 'Enter a URL or search terms.' });
  });

  it('treats a half-typed scheme as unfinished, not as a search', () => {
    for (const typed of ['https:', 'https:/', 'https://'])
      expect(resolveBrowserAddress(typed)).toEqual({
        kind: 'error',
        message: 'Keep typing—add a site after https://',
      });
    expect(resolveBrowserAddress('HTTP://')).toEqual({
      kind: 'error',
      message: 'Keep typing—add a site after http://',
    });
  });

  it('refuses a scheme this surface will never open', () => {
    expect(resolveBrowserAddress('ftp://files.example.test/a')).toEqual({
      kind: 'error',
      message: 'Only HTTP and HTTPS addresses can be opened.',
    });
    expect(resolveBrowserAddress('javascript:alert(1)').kind).toBe('error');
  });

  it('takes an explicit http(s) address as written', () => {
    const resolved = resolveBrowserAddress('https://docs.example.test/a', APP_BASE);
    expect(resolved).toMatchObject({ kind: 'url' });
    expect(resolved.kind === 'url' && resolved.destination.href).toBe('https://docs.example.test/a');
  });

  it('keeps a relative path on the current site', () => {
    const resolved = resolveBrowserAddress('/docs', APP_BASE);
    expect(resolved.kind === 'url' && resolved.destination.href).toBe('https://app.example.test/docs');
    expect(resolveBrowserAddress('?q=1', APP_BASE).kind).toBe('url');
    expect(resolveBrowserAddress('./there', APP_BASE).kind).toBe('url');
  });

  it('says so when a relative address cannot be resolved at all', () => {
    expect(resolveBrowserAddress('/docs', 'not a base')).toEqual({
      kind: 'error',
      message: 'That relative address is not valid.',
    });
  });

  it('gives a bare host https, and a loopback host http', () => {
    expect(resolveBrowserAddress('example.test/a', APP_BASE).kind).toBe('url');
    expect(resolveBrowserAddress('example.test/a', APP_BASE)).toMatchObject({
      destination: { href: 'https://example.test/a' },
    });
    expect(resolveBrowserAddress('localhost:5173', APP_BASE)).toMatchObject({
      destination: { href: 'http://localhost:5173/' },
    });
    expect(resolveBrowserAddress('127.0.0.1:8080/x', APP_BASE)).toMatchObject({
      destination: { href: 'http://127.0.0.1:8080/x' },
    });
    expect(resolveBrowserAddress('[::1]:9000/x', APP_BASE)).toMatchObject({ kind: 'url' });
    expect(resolveBrowserAddress('192.168.1.4', APP_BASE)).toMatchObject({
      destination: { href: 'https://192.168.1.4/' },
    });
  });

  it('searches, explicitly, for anything that is not an address', () => {
    const resolved = resolveBrowserAddress('how do daemons pair', APP_BASE);
    expect(resolved.kind).toBe('search');
    expect(resolved.kind === 'search' && resolved.destination.href).toBe(
      'https://duckduckgo.com/?q=how+do+daemons+pair',
    );
    // A single bare word with no dot is a search too, not a hostname guess.
    expect(resolveBrowserAddress('ferretry', APP_BASE).kind).toBe('search');
  });

  it('refuses an address that only looks complete', () => {
    expect(resolveBrowserAddress('https://', APP_BASE).kind).toBe('error');
    expect(resolveBrowserAddress('http://%%%', APP_BASE)).toEqual({
      kind: 'error',
      message: 'Enter a complete HTTP or HTTPS address.',
    });
  });
});

describe('the preview engine’s history', () => {
  const first = destination('https://a.example.test/');
  const second = destination('https://b.example.test/');
  const third = destination('https://c.example.test/');

  it('starts empty, or on the destination it was handed', () => {
    expect(createPreviewHistory()).toEqual({ entries: [], index: -1, revision: 0 });
    expect(createPreviewHistory(null)).toEqual({ entries: [], index: -1, revision: 0 });
    expect(createPreviewHistory(first)).toEqual({ entries: [first], index: 0, revision: 0 });
    expect(currentPreviewEntry(createPreviewHistory())).toBeNull();
    expect(currentPreviewEntry(createPreviewHistory(first))).toBe(first);
  });

  it('treats re-opening the same address as a reload, not a new entry', () => {
    const history = pushPreviewHistory(createPreviewHistory(first), first);
    expect(history.entries).toHaveLength(1);
    expect(history.revision).toBe(1);
    expect(pushPreviewHistory(history, first).revision).toBe(2);
  });

  it('drops the forward entries when the reader navigates from the middle', () => {
    let history = pushPreviewHistory(pushPreviewHistory(createPreviewHistory(first), second), third);
    expect(history.index).toBe(2);
    history = movePreviewHistory(history, -1);
    expect(currentPreviewEntry(history)).toBe(second);
    history = pushPreviewHistory(history, destination('https://d.example.test/'));
    expect(history.entries.map(entry => entry.href)).toEqual([
      'https://a.example.test/',
      'https://b.example.test/',
      'https://d.example.test/',
    ]);
  });

  it('clamps at both ends and leaves an empty history alone', () => {
    const empty = createPreviewHistory();
    expect(movePreviewHistory(empty, -1)).toBe(empty);
    expect(movePreviewHistory(empty, 1)).toBe(empty);

    const one = createPreviewHistory(first);
    expect(movePreviewHistory(one, -1)).toBe(one);
    expect(movePreviewHistory(one, 1)).toBe(one);

    const two = pushPreviewHistory(one, second);
    expect(currentPreviewEntry(movePreviewHistory(two, -1))).toBe(first);
    expect(currentPreviewEntry(movePreviewHistory(movePreviewHistory(two, -1), 1))).toBe(second);
  });

  it('clears a pending reload once the reader actually moves', () => {
    const reloaded = pushPreviewHistory(pushPreviewHistory(createPreviewHistory(first), second), second);
    expect(reloaded.revision).toBe(1);
    expect(movePreviewHistory(reloaded, -1).revision).toBe(0);
  });
});
