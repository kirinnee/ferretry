import { describe, expect, it } from 'bun:test';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import {
  decodeRemoteBrowserFrame,
  fetchRemoteBrowserStatus,
  isLocalPasteChord,
  nextRemoteClickRun,
  REMOTE_MAX_CLICK_COUNT,
  remoteBrowserStreamUrl,
  remoteCanvasPoint,
  remoteInputModifiers,
  remoteKeyInput,
  remoteKeyRelease,
  remotePageLabel,
  remotePointerButton,
  remoteViewportForContainer,
  runRemoteBrowserAction,
  type RemoteKeyEvent,
} from '../../src/lib/remote-browser.ts';
import type { BrowserStatus } from '@ferretry/protocol';

const daemon = daemonConnection({
  daemonId: 'daemon-a',
  baseUrl: 'https://daemon.example.test',
  deviceToken: 'secret-token',
});
const scope = daemonSessionScope(daemon, 'same/session');
const status = {
  sessionId: 'same/session',
  state: 'stopped',
  pages: [],
  viewport: { width: 320, height: 240 },
  viewers: 0,
  persistentProfile: true,
  idleTimeoutSeconds: 60,
  capacity: { running: 0, maximum: 3 },
} satisfies BrowserStatus;
const response = (body: unknown, statusCode = 200) => new Response(JSON.stringify(body), { status: statusCode });

describe('remote browser transport', () => {
  it('binds status and actions to a paired daemon and rejects a crossed scope', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return response(calls.length === 1 ? status : { status });
    };
    expect(await fetchRemoteBrowserStatus(daemon, scope, fetcher)).toEqual(status);
    expect(await runRemoteBrowserAction(daemon, scope, { action: 'start' }, fetcher)).toEqual({ status });
    expect(calls[0]?.url).toBe('https://daemon.example.test/v1/sessions/same%2Fsession/browser');
    expect(new Headers(calls[1]?.init?.headers).get('authorization')).toBe('Bearer secret-token');
    expect(new Headers(calls[1]?.init?.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ action: 'start' });
    const other = daemonSessionScope(
      daemonConnection({ daemonId: 'daemon-b', baseUrl: 'https://b.example.test', deviceToken: 'b' }),
      'same/session',
    );
    await expect(fetchRemoteBrowserStatus(daemon, other, fetcher)).rejects.toThrow('browser scope must belong');
  });

  it('keeps failure detail and schema validation honest', async () => {
    await expect(
      fetchRemoteBrowserStatus(daemon, scope, async () => response({ error: 'no browser', code: 'missing' }, 404)),
    ).rejects.toMatchObject({ status: 404, code: 'missing' });
    await expect(
      fetchRemoteBrowserStatus(daemon, scope, async () => new Response('not json', { status: 500 })),
    ).rejects.toMatchObject({ status: 500, code: undefined });
    await expect(fetchRemoteBrowserStatus(daemon, scope, async () => response({ nope: true }))).rejects.toThrow();
    await expect(
      runRemoteBrowserAction(daemon, scope, { action: 'stop' }, async () =>
        response({ status: { ...status, state: 'bad' } }),
      ),
    ).rejects.toThrow();
  });

  it('builds a ticket-only browser stream URL on the paired daemon', () => {
    expect(remoteBrowserStreamUrl(daemon, scope, 'one-time')).toBe(
      'wss://daemon.example.test/v1/sessions/same%2Fsession/browser/stream?ticket=one-time',
    );
    expect(
      remoteBrowserStreamUrl(
        daemonConnection({ daemonId: 'loop', baseUrl: 'http://127.0.0.1:7337', deviceToken: 'x' }),
        daemonSessionScope({ daemonId: 'loop' as never }, 'x'),
        't',
      ),
    ).toBe('ws://127.0.0.1:7337/v1/sessions/x/browser/stream?ticket=t');
    expect(() => remoteBrowserStreamUrl(daemon, scope, ' ')).toThrow('browser stream ticket must not be empty');
  });
});

describe('remote browser frame and geometry helpers', () => {
  it('decodes tagged frames and refuses malformed envelopes without downgrading them', () => {
    const id = new TextEncoder().encode('page-a');
    const frame = new Uint8Array(7 + id.length + 2);
    frame.set([0x4b, 0x42, 0x52, 0x46, 1, 0, id.length]);
    frame.set(id, 7);
    frame.set([1, 2], 7 + id.length);
    expect(decodeRemoteBrowserFrame(frame.buffer)).toEqual({
      kind: 'tagged',
      pageId: 'page-a',
      jpegBytes: frame.buffer.slice(13),
    });
    expect(decodeRemoteBrowserFrame(new Uint8Array([0x4b, 0x42]).buffer)).toBeNull();
    expect(decodeRemoteBrowserFrame(new Uint8Array([0x4b, 0x42, 0x52, 0x46, 2, 0, 1, 97, 1]).buffer)).toBeNull();
    expect(decodeRemoteBrowserFrame(new Uint8Array([0x4b, 0x42, 0x52, 0x46, 1, 0, 1, 0xff, 1]).buffer)).toBeNull();
    expect(decodeRemoteBrowserFrame(new Uint8Array([1, 2]).buffer)).toEqual({
      kind: 'legacy',
      jpegBytes: new Uint8Array([1, 2]).buffer,
    });
  });

  it('maps responsive and desktop viewports plus edge canvas points', () => {
    expect(remoteViewportForContainer(12.4, 900.7, 'responsive')).toEqual({ width: 320, height: 901 });
    expect(remoteViewportForContainer(3000, 3000, 'responsive')).toEqual({ width: 1920, height: 1200 });
    expect(remoteViewportForContainer(10, 10, 'desktop')).toEqual({ width: 1280, height: 800 });
    expect(remoteViewportForContainer(Number.NaN, 1, 'responsive')).toBeNull();
    expect(remoteCanvasPoint({ left: 10, top: 10, width: 100, height: 50 }, 200, 100, 200, -2)).toEqual({
      x: 199,
      y: 0,
    });
  });
});

const keyEvent = (overrides: Partial<RemoteKeyEvent> = {}): RemoteKeyEvent => ({
  key: 'a',
  code: 'KeyA',
  keyCode: 65,
  location: 0,
  repeat: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...overrides,
});

describe('remote browser input translation', () => {
  it('continues a click run only inside the time and distance window', () => {
    const first = nextRemoteClickRun(null, { x: 10, y: 10 }, 1_000);
    expect(first).toEqual({ count: 1, at: 1_000, x: 10, y: 10 });
    const second = nextRemoteClickRun(first, { x: 14, y: 6 }, 1_400);
    expect(second.count).toBe(2);
    const third = nextRemoteClickRun(second, { x: 14, y: 6 }, 1_500);
    expect(third.count).toBe(3);
    // The run is capped, so a fourth rapid press stays a triple-click.
    expect(nextRemoteClickRun(third, { x: 14, y: 6 }, 1_600).count).toBe(REMOTE_MAX_CLICK_COUNT);
    // Too slow restarts the run; so does drifting past the slop box on either axis.
    expect(nextRemoteClickRun(third, { x: 14, y: 6 }, 2_500).count).toBe(1);
    expect(nextRemoteClickRun(third, { x: 40, y: 6 }, 1_650).count).toBe(1);
    expect(nextRemoteClickRun(third, { x: 14, y: 40 }, 1_650).count).toBe(1);
  });

  it('recognises only the local paste chord', () => {
    expect(isLocalPasteChord({ key: 'v', ctrlKey: true, metaKey: false })).toBe(true);
    expect(isLocalPasteChord({ key: 'V', ctrlKey: false, metaKey: true })).toBe(true);
    expect(isLocalPasteChord({ key: 'v', ctrlKey: false, metaKey: false })).toBe(false);
    expect(isLocalPasteChord({ key: 'c', ctrlKey: true, metaKey: false })).toBe(false);
  });

  it('maps pointer buttons and packs modifier flags', () => {
    expect([0, 1, 2, 3, 4].map(remotePointerButton)).toEqual(['left', 'middle', 'right', 'back', 'forward']);
    expect(remotePointerButton(9)).toBe('none');
    expect(remotePointerButton(-1)).toBe('none');
    expect(remoteInputModifiers({ altKey: false, ctrlKey: false, metaKey: false, shiftKey: false })).toBe(0);
    expect(remoteInputModifiers({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true })).toBe(15);
    expect(remoteInputModifiers({ altKey: false, ctrlKey: true, metaKey: false, shiftKey: true })).toBe(10);
  });

  it('attaches text only to an unmodified printable key-down', () => {
    expect(remoteKeyInput(keyEvent({ shiftKey: true, key: 'A' }), 'keyDown')).toMatchObject({
      kind: 'key',
      type: 'keyDown',
      text: 'A',
      unmodifiedText: 'A',
      modifiers: 8,
    });
    // A chord must not also insert its character, and a key-up never carries text.
    expect(remoteKeyInput(keyEvent({ ctrlKey: true }), 'keyDown')).not.toHaveProperty('text');
    expect(remoteKeyInput(keyEvent({ metaKey: true }), 'keyDown')).not.toHaveProperty('text');
    expect(remoteKeyInput(keyEvent({ altKey: true }), 'keyDown')).not.toHaveProperty('text');
    expect(remoteKeyInput(keyEvent({ key: 'Enter', code: 'Enter' }), 'keyDown')).not.toHaveProperty('text');
    expect(remoteKeyInput(keyEvent(), 'keyUp')).not.toHaveProperty('text');
    expect(remoteKeyInput(keyEvent({ location: 3, repeat: true }), 'keyDown')).toMatchObject({
      isKeypad: true,
      autoRepeat: true,
    });
  });

  it('releases a retained key without its text or stale modifiers', () => {
    expect(remoteKeyRelease(remoteKeyInput(keyEvent({ shiftKey: true }), 'keyDown'))).toEqual({
      kind: 'key',
      type: 'keyUp',
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
      modifiers: 0,
      autoRepeat: false,
      isKeypad: false,
    });
    // Only key events are ever retained, so nothing else can be released.
    expect(remoteKeyRelease({ kind: 'insertText', text: 'hi' })).toBeNull();
  });

  it('labels a page from the real title, then its host, then its url', () => {
    expect(remotePageLabel({ id: '1', url: 'https://example.test/a', title: '  Docs  ' })).toBe('Docs');
    expect(remotePageLabel({ id: '1', url: 'https://example.test/a', title: '' })).toBe('example.test');
    expect(remotePageLabel({ id: '1', url: 'about:blank', title: '' })).toBe('New tab');
    expect(remotePageLabel({ id: '1', url: '', title: '' })).toBe('New tab');
    expect(remotePageLabel({ id: '1', url: 'not a url', title: '' })).toBe('not a url');
    expect(remotePageLabel({ id: '1', url: 'file:///tmp/x', title: '' })).toBe('file:///tmp/x');
  });
});
