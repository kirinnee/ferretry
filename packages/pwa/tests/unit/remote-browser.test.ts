import { describe, expect, it } from 'bun:test';
import type { BrowserStatus } from '@ferretry/protocol';
import { FY_REQUEST_ID_HEADER } from '@ferretry/protocol';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import {
  decodeRemoteBrowserFrame,
  fetchRemoteBrowserStatus,
  fetchRemoteBrowserStreamTicket,
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

  it('stamps the protocol request id on the action mutation only, never the obsolete header', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return response(calls.length === 1 ? status : { status });
    };
    await fetchRemoteBrowserStatus(daemon, scope, fetcher);
    await runRemoteBrowserAction(daemon, scope, { action: 'start' }, fetcher);
    const headers = (index: number) => new Headers(calls[index]?.init?.headers);
    expect(headers(0).get(FY_REQUEST_ID_HEADER)).toBeNull();
    expect(headers(1).get(FY_REQUEST_ID_HEADER)).toMatch(/^[0-9a-f-]{36}$/u);
    expect(headers(1).get('x-kteam-request-id')).toBeNull();
  });

  it('rejects a server response that describes another session before publication', async () => {
    const crossed = { ...status, sessionId: 'other/session' };
    await expect(fetchRemoteBrowserStatus(daemon, scope, async () => response(crossed))).rejects.toThrow(
      'daemon returned another session',
    );
    await expect(
      runRemoteBrowserAction(daemon, scope, { action: 'start' }, async () => response({ status: crossed })),
    ).rejects.toThrow('daemon returned another session');
  });

  it('builds a ticket-only browser stream URL on the paired daemon', () => {
    expect(remoteBrowserStreamUrl(daemon, scope, 'one-time')).toBe(
      'wss://daemon.example.test/v1/sessions/same%2Fsession/browser/stream?ticket=one-time',
    );
    expect(
      remoteBrowserStreamUrl(
        daemonConnection({ daemonId: 'loop', baseUrl: 'http://127.0.0.1:7431', deviceToken: 'x' }),
        daemonSessionScope({ daemonId: 'loop' as never }, 'x'),
        't',
      ),
    ).toBe('ws://127.0.0.1:7431/v1/sessions/x/browser/stream?ticket=t');
    expect(() => remoteBrowserStreamUrl(daemon, scope, ' ')).toThrow('browser stream ticket must not be empty');
  });
});

/**
 * The daemon's frame envelope, encoded exactly the way the daemon's own codec
 * does (`packages/daemon/src/lib/browser/transport/envelope.ts`): ASCII `FYBF`,
 * one version byte, a big-endian uint16 UTF-8 page-id byte length, the page id,
 * then the JPEG bytes. Written out here rather than imported so this suite stays
 * inside its own package while still asserting the real wire shape — if the two
 * ever disagree again, this is the test that says so.
 */
const daemonFrameEnvelope = (pageId: string, jpeg: readonly number[]): ArrayBuffer => {
  const id = new TextEncoder().encode(pageId);
  const bytes = new Uint8Array(7 + id.length + jpeg.length);
  bytes.set([0x46, 0x59, 0x42, 0x46, 1]);
  new DataView(bytes.buffer).setUint16(5, id.length, false);
  bytes.set(id, 7);
  bytes.set(jpeg, 7 + id.length);
  return bytes.buffer;
};

describe('remote browser frame and geometry helpers', () => {
  it('decodes a frame in the daemon wire shape, keeping only the JPEG payload', () => {
    const message = daemonFrameEnvelope('page-a', [1, 2]);
    expect(decodeRemoteBrowserFrame(message)).toEqual({
      kind: 'tagged',
      pageId: 'page-a',
      jpegBytes: message.slice(13),
    });
    // A multi-byte page id is measured in BYTES, not code units, on both sides.
    const wide = daemonFrameEnvelope('päge', [9]);
    expect(decodeRemoteBrowserFrame(wide)).toEqual({ kind: 'tagged', pageId: 'päge', jpegBytes: wide.slice(12) });
  });

  it('rejects the pre-Ferretry magic instead of serving its header as pixels', () => {
    // The port shipped with this magic while the daemon emits `FYBF`. Decoding it
    // as an untagged JPEG is what made the drift invisible, so it must fail
    // closed: no frame, no page id, nothing painted.
    const id = new TextEncoder().encode('page-a');
    const stale = new Uint8Array(7 + id.length + 2);
    stale.set([0x4b, 0x42, 0x52, 0x46, 1, 0, id.length]);
    stale.set(id, 7);
    stale.set([1, 2], 7 + id.length);
    expect(decodeRemoteBrowserFrame(stale.buffer)).toBeNull();
  });

  it('refuses every message it cannot attribute to a page', () => {
    const magic = [0x46, 0x59, 0x42, 0x46];
    // No magic at all: a bare JPEG is no longer downgraded to an untagged frame.
    expect(decodeRemoteBrowserFrame(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).buffer)).toBeNull();
    expect(decodeRemoteBrowserFrame(new Uint8Array([]).buffer)).toBeNull();
    // Truncated: the magic alone is not a header.
    expect(decodeRemoteBrowserFrame(new Uint8Array(magic).buffer)).toBeNull();
    // One wrong magic byte.
    expect(decodeRemoteBrowserFrame(new Uint8Array([0x46, 0x59, 0x42, 0x47, 1, 0, 1, 97, 1]).buffer)).toBeNull();
    // Unsupported version.
    expect(decodeRemoteBrowserFrame(new Uint8Array([...magic, 2, 0, 1, 97, 1]).buffer)).toBeNull();
    // Zero-length page id, and a length that runs past the message.
    expect(decodeRemoteBrowserFrame(new Uint8Array([...magic, 1, 0, 0, 97, 1]).buffer)).toBeNull();
    expect(decodeRemoteBrowserFrame(new Uint8Array([...magic, 1, 0, 0xff, 97, 1]).buffer)).toBeNull();
    // A declared page id that consumes the whole message leaves no JPEG.
    expect(decodeRemoteBrowserFrame(new Uint8Array([...magic, 1, 0, 2, 97, 98]).buffer)).toBeNull();
    // Invalid UTF-8 in the page id.
    expect(decodeRemoteBrowserFrame(new Uint8Array([...magic, 1, 0, 1, 0xff, 1]).buffer)).toBeNull();
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

  it('buys a stream ticket for the paired daemon and refuses every answer that is not one', async () => {
    // The viewer's WebSocket cannot carry the device token, so this exchange is the ONLY thing
    // standing between a paired browser and an unauthenticated stream. An answer that is missing or
    // blank must fail here rather than downstream, where an empty ticket would become a socket URL.
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return response({ ticket: 'fy_ticket_abc', ttlSeconds: 30 }, 201);
    };

    expect(await fetchRemoteBrowserStreamTicket(daemon, scope, fetcher)).toBe('fy_ticket_abc');
    expect(calls[0]?.url).toBe('https://daemon.example.test/v1/sessions/same%2Fsession/browser/stream/ticket');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe('Bearer secret-token');
    // The counter's own refusal is preserved, so a caller can tell "no such browser" from a defect.
    await expect(
      fetchRemoteBrowserStreamTicket(daemon, scope, async () =>
        response({ error: 'no browser', code: 'not_found' }, 404),
      ),
    ).rejects.toMatchObject({ status: 404, code: 'not_found' });
    // A 200 that carries no usable ticket is the daemon failing, not the caller.
    await expect(fetchRemoteBrowserStreamTicket(daemon, scope, async () => response({}))).rejects.toMatchObject({
      status: 502,
    });
    await expect(
      fetchRemoteBrowserStreamTicket(daemon, scope, async () => response({ ticket: '   ' })),
    ).rejects.toMatchObject({ status: 502 });
    // And it is bound to the daemon the scope names, exactly like the status and action calls.
    const other = daemonSessionScope(
      daemonConnection({ daemonId: 'daemon-b', baseUrl: 'https://b.example.test', deviceToken: 'b' }),
      'same/session',
    );
    await expect(fetchRemoteBrowserStreamTicket(daemon, other, fetcher)).rejects.toThrow('browser scope must belong');
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
