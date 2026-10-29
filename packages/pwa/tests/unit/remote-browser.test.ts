import { describe, expect, it } from 'bun:test';
import type { BrowserStatus } from '@ferretry/protocol';
import { encodeBrowserStreamChunks, FY_REQUEST_ID_HEADER } from '@ferretry/protocol';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import {
  type RelayClientSession,
  type RelayStreamFrame,
  RelayStreamRefusedError,
} from '../../src/lib/relay-session.ts';
import {
  decodeRemoteBrowserFrame,
  fetchRemoteBrowserStatus,
  isLocalPasteChord,
  isRemoteCompositionKey,
  nextRemoteClickRun,
  REMOTE_MAX_CLICK_COUNT,
  type RemoteBrowserSocket,
  type RemoteKeyEvent,
  remoteBrowserStreamSocketFactory,
  remoteCanvasPoint,
  remoteInputModifiers,
  remoteKeyInput,
  remoteKeyRelease,
  remoteKeyText,
  remotePageLabel,
  remotePointerButton,
  remoteViewportForContainer,
  runRemoteBrowserAction,
} from '../../src/lib/remote-browser.ts';

const daemon = daemonConnection({
  daemonId: 'daemon-a',
  baseUrl: 'https://daemon.example.test',
  deviceId: 'secret-token',
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

/** The three things the display asks of a §14 stream session, recorded. */
const fakeStreamSession = () => {
  const sent: RelayStreamFrame[] = [];
  const closes: { code: number; reason: string }[] = [];
  const listeners: ((closed: { code: number; reason: string }) => void)[] = [];
  const fake = {
    sent,
    closes,
    onData: undefined as ((frame: RelayStreamFrame) => void) | undefined,
    endStream: (code: number, reason: string) => {
      for (const listener of listeners) listener({ code, reason });
    },
    session: {
      sendStream: (frame: RelayStreamFrame) => {
        sent.push(frame);
      },
      closeStream: (code: number, reason: string) => {
        closes.push({ code, reason });
      },
      onStreamClosed: (listener: (closed: { code: number; reason: string }) => void) => {
        listeners.push(listener);
      },
    } as unknown as RelayClientSession,
  };
  return fake;
};

/** Every event a display socket raised, in order. */
const recordEvents = (socket: RemoteBrowserSocket) => {
  const types: string[] = [];
  const messages: unknown[] = [];
  const closes: { code: number; reason: string }[] = [];
  for (const type of ['open', 'message', 'close', 'error'] as const)
    socket.addEventListener(type, event => {
      types.push(type);
      if (event instanceof MessageEvent) messages.push(event.data);
      if (event instanceof CloseEvent) closes.push({ code: event.code, reason: event.reason });
    });
  return { types, messages, closes };
};

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
    expect(new Headers(calls[1]?.init?.headers).has('authorization')).toBe(false);
    expect(new Headers(calls[1]?.init?.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ action: 'start' });
    const other = daemonSessionScope(
      daemonConnection({ daemonId: 'daemon-b', baseUrl: 'https://b.example.test', deviceId: 'b' }),
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

  it('opens the display as a stream session on the paired daemon, with no ticket', async () => {
    const opened: { daemon: unknown; path: string; query: unknown }[] = [];
    const fake = fakeStreamSession();
    const socket = remoteBrowserStreamSocketFactory(async (paired, request) => {
      opened.push({ daemon: paired, path: request.path, query: request.query });
      fake.onData = request.onData;
      return fake.session;
    })(daemon, scope);
    const events = recordEvents(socket);
    expect(socket.readyState).toBe(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(opened).toEqual([{ daemon, path: '/v1/sessions/same%2Fsession/browser/stream', query: undefined }]);
    expect(socket.readyState).toBe(1);
    expect(events.types).toEqual(['open']);

    // A frame cut into chunks arrives as one whole envelope; text from the daemon is ignored.
    const envelope = Uint8Array.of(0x46, 0x59, 0x42, 0x46, 1, 0, 1, 0x70, 9, 8, 7);
    fake.onData?.({ kind: 'text', text: 'not a frame' });
    for (const chunk of encodeBrowserStreamChunks(3, envelope, 25)) fake.onData?.({ kind: 'bytes', bytes: chunk });
    expect(events.types).toEqual(['open', 'message']);
    expect([...new Uint8Array(events.messages[0] as ArrayBuffer)]).toEqual([...envelope]);

    // Input is one JSON text record; a viewer leaving says so on the wire.
    socket.send('{"kind":"insertText","text":"hi"}');
    expect(fake.sent).toEqual([{ kind: 'text', text: '{"kind":"insertText","text":"hi"}' }]);
    socket.close(1000, 'viewer detached');
    expect(fake.closes).toEqual([{ code: 1000, reason: 'viewer detached' }]);
    expect(socket.readyState).toBe(3);
    socket.send('late');
    socket.close();
    expect(fake.sent).toHaveLength(1);
    expect(fake.closes).toHaveLength(1);
  });

  it('reports the stream close the daemon sealed, and a frame that arrives before the open resolves', async () => {
    const fake = fakeStreamSession();
    let resolveOpen: ((session: typeof fake.session) => void) | undefined;
    const socket = remoteBrowserStreamSocketFactory(async (_paired, request) => {
      fake.onData = request.onData;
      return await new Promise(resolve => {
        resolveOpen = resolve;
      });
    })(daemon, scope);
    const events = recordEvents(socket);
    await Promise.resolve();
    // Sent before the session promise exists: the stream is open by the evidence of its data.
    for (const chunk of encodeBrowserStreamChunks(0, Uint8Array.of(1, 2, 3), 100))
      fake.onData?.({ kind: 'bytes', bytes: chunk });
    expect(events.types).toEqual(['open', 'message']);
    socket.send('dropped: no session yet');
    resolveOpen?.(fake.session);
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.sent).toHaveLength(0);
    fake.endStream(1013, 'browser viewer fell behind');
    expect(events.types).toEqual(['open', 'message', 'close']);
    expect(events.closes).toEqual([{ code: 1013, reason: 'browser viewer fell behind' }]);
    fake.endStream(1000, 'twice');
    expect(events.closes).toHaveLength(1);
  });

  it('ends a stream whose framing broke instead of painting it', async () => {
    const fake = fakeStreamSession();
    const socket = remoteBrowserStreamSocketFactory(async (_paired, request) => {
      fake.onData = request.onData;
      return fake.session;
    })(daemon, scope);
    const events = recordEvents(socket);
    await Promise.resolve();
    await Promise.resolve();
    fake.onData?.({ kind: 'bytes', bytes: new Uint8Array(30) });
    expect(events.closes).toEqual([{ code: 1003, reason: 'browser stream chunk magic does not match' }]);
    expect(fake.closes).toEqual([{ code: 1003, reason: 'the viewer could not read this stream' }]);
    fake.onData?.({ kind: 'bytes', bytes: new Uint8Array(30) });
    expect(events.types.filter(type => type === 'close')).toHaveLength(1);
  });

  it('leaves on the wire once the stream opens, when the viewer left while it was opening', async () => {
    const fake = fakeStreamSession();
    let resolveOpen: ((session: typeof fake.session) => void) | undefined;
    const socket = remoteBrowserStreamSocketFactory(
      async () =>
        await new Promise(resolve => {
          resolveOpen = resolve;
        }),
    )(daemon, scope);
    const events = recordEvents(socket);
    await Promise.resolve();
    socket.close(1000, 'viewer detached');
    resolveOpen?.(fake.session);
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.closes).toEqual([{ code: 1000, reason: 'viewer detached' }]);
    expect(events.types).toEqual([]);
  });

  it('tells a refusal it may retry from one it may not, and a carrier that failed from both', async () => {
    const closeFor = async (reason: unknown) => {
      const socket = remoteBrowserStreamSocketFactory(async () => {
        throw reason;
      })(daemon, scope);
      const events = recordEvents(socket);
      await Promise.resolve();
      await Promise.resolve();
      return events;
    };
    const forbidden = await closeFor(new RelayStreamRefusedError(403, 'browser use is not granted'));
    expect(forbidden.types).toEqual(['error', 'close']);
    expect(forbidden.closes).toEqual([{ code: 1008, reason: 'browser use is not granted' }]);
    expect((await closeFor(new RelayStreamRefusedError(401, 'who'))).closes[0]?.code).toBe(1008);
    expect((await closeFor(new RelayStreamRefusedError(409, 'no page yet'))).closes).toEqual([
      { code: 1011, reason: 'no page yet' },
    ]);
    expect((await closeFor(new Error('no carrier reached the daemon'))).closes).toEqual([
      { code: 1006, reason: 'no carrier reached the daemon' },
    ]);
    expect((await closeFor('odd')).closes).toEqual([{ code: 1006, reason: 'the display stream did not open' }]);

    // A viewer that already left hears nothing about the failed open.
    let fail: ((reason: unknown) => void) | undefined;
    const socket = remoteBrowserStreamSocketFactory(
      async () =>
        await new Promise((_resolve, reject) => {
          fail = reject;
        }),
    )(daemon, scope);
    const events = recordEvents(socket);
    socket.close();
    fail?.(new Error('late'));
    await Promise.resolve();
    await Promise.resolve();
    expect(events.types).toEqual([]);
  });

  it('swallows an input send the ended session refuses', async () => {
    const fake = fakeStreamSession();
    fake.session.sendStream = () => {
      throw new Error('this relay session is not carrying a stream');
    };
    const socket = remoteBrowserStreamSocketFactory(async () => fake.session)(daemon, scope);
    await Promise.resolve();
    await Promise.resolve();
    expect(() => socket.send('{}')).not.toThrow();
  });

  it('refuses a scope that belongs to another daemon', () => {
    expect(() =>
      remoteBrowserStreamSocketFactory(async () => fakeStreamSession().session)(
        daemon,
        daemonSessionScope({ daemonId: 'other' as never }, 'x'),
      ),
    ).toThrow('browser scope must belong to the requested daemon');
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

  it('refuses a page id that is only a byte-order mark, over-long, or whose length disagrees with its bytes', () => {
    const magic = [0x46, 0x59, 0x42, 0x46];
    // The decoder drops a leading byte-order mark, so these bytes name no page at all.
    expect(decodeRemoteBrowserFrame(new Uint8Array([...magic, 1, 0, 3, 0xef, 0xbb, 0xbf, 1]).buffer)).toBeNull();
    // The mark is dropped from the text but still counted in the declared length: the two disagree.
    expect(decodeRemoteBrowserFrame(new Uint8Array([...magic, 1, 0, 4, 0xef, 0xbb, 0xbf, 97, 1]).buffer)).toBeNull();
    // One character past the page-id limit, though still inside the byte allowance.
    expect(decodeRemoteBrowserFrame(daemonFrameEnvelope('a'.repeat(129), [1]))).toBeNull();
    expect(decodeRemoteBrowserFrame(daemonFrameEnvelope('a'.repeat(128), [1]))).toEqual({
      kind: 'tagged',
      pageId: 'a'.repeat(128),
      jpegBytes: new Uint8Array([1]).buffer,
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
    expect(remoteKeyInput(keyEvent({ key: 'Enter', code: 'Enter' }), 'keyDown')).toMatchObject({ text: '\r' });
    expect(remoteKeyInput(keyEvent(), 'keyUp')).not.toHaveProperty('text');
    expect(remoteKeyInput(keyEvent({ location: 3, repeat: true }), 'keyDown')).toMatchObject({
      isKeypad: true,
      autoRepeat: true,
    });
  });

  it('types every printable ASCII character, shifted and unshifted, as its own text', () => {
    const shifted = '~!@#$%^&*()_+{}|:"<>?ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    for (let code = 0x20; code <= 0x7e; code += 1) {
      const key = String.fromCharCode(code);
      const input = remoteKeyInput(keyEvent({ key, shiftKey: shifted.includes(key) }), 'keyDown');
      expect(input).toMatchObject({ key, text: key, unmodifiedText: key });
    }
  });

  it('types a layout character that Alt, AltGr or an astral code point produced', () => {
    // macOS Option+O is "ø": a non-ASCII character is the layout's own text, not a shortcut.
    expect(remoteKeyText(keyEvent({ key: 'ø', altKey: true }))).toBe('ø');
    // Alt+F on Windows/Linux is a menu/shortcut, so it carries no text.
    expect(remoteKeyText(keyEvent({ key: 'f', altKey: true }))).toBeNull();
    // German AltGr+Q is "@", reported as Ctrl+Alt on Windows; it is text, not a chord.
    const altGr = keyEvent({ key: '@', code: 'KeyQ', altKey: true, ctrlKey: true, altGraph: true });
    expect(remoteKeyText(altGr)).toBe('@');
    expect(remoteKeyInput(altGr, 'keyDown')).toMatchObject({ text: '@', modifiers: 0 });
    expect(remoteKeyText(keyEvent({ key: 'q', altKey: true, ctrlKey: true }))).toBeNull();
    expect(remoteKeyText(keyEvent({ key: '😀' }))).toBe('😀');
    expect(remoteKeyText(keyEvent({ key: '😀', metaKey: true }))).toBeNull();
    expect(remoteKeyText(keyEvent({ key: 'Enter' }))).toBe('\r');
    expect(remoteKeyText(keyEvent({ key: 'Enter', shiftKey: true }))).toBe('\r');
    for (const chord of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }])
      expect(remoteKeyText(keyEvent({ key: 'Enter', ...chord }))).toBeNull();
    expect(remoteKeyText(keyEvent({ key: 'Tab' }))).toBeNull();
    expect(remoteKeyText(keyEvent({ key: '' }))).toBeNull();
  });

  it('recognises composition keys that must not be sent as key presses', () => {
    expect(isRemoteCompositionKey({ key: 'a', keyCode: 229 })).toBe(true);
    expect(isRemoteCompositionKey({ key: 'Dead', keyCode: 192 })).toBe(true);
    expect(isRemoteCompositionKey({ key: 'Process', keyCode: 0 })).toBe(true);
    expect(isRemoteCompositionKey({ key: 'Unidentified', keyCode: 0 })).toBe(true);
    expect(isRemoteCompositionKey({ key: 'a', keyCode: 65 })).toBe(false);
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
