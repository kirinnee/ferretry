// A scriptable stand-in for the real browser worker: it speaks the same JSON-lines protocol with no
// browser behind it, so the client's framing, timeouts, and lifecycle can be tested for real.
//
// The endpoint argument selects a launch behaviour; individual request methods select reply
// behaviours. Nothing here touches the network, a browser, or any state outside this process.

const endpoint = process.argv[2] ?? 'ready';

if (endpoint === 'stubborn-close') {
  // A real browser worker traps SIGTERM to close Chrome cleanly. This one never finishes, which is
  // what makes SIGKILL escalation the only way out.
  process.on('SIGTERM', () => {});
  // stdin ending must not end the process either, or the escalation path is never reached.
  process.stdin.on('end', () => {});
  setInterval(() => {}, 1_000);
}

function emit(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function reply(id, ok, payload) {
  emit(ok ? { id, ok: true, result: payload } : { id, ok: false, error: payload });
}

/** A snapshot that reports which method and params arrived, through the real protocol shape. */
function snapshot(method, params) {
  const url = `https://example.test/?params=${encodeURIComponent(JSON.stringify(params ?? {}))}`;
  return {
    activePageId: 'p1',
    actedPageId: 'p1',
    pages: [{ id: 'p1', url, title: method }],
    pageState: 'ready',
    canGoBack: false,
    canGoForward: false,
    text: 'page text',
    screenshotBase64: 'AAAA',
  };
}

let nextAckId = 1;
const acknowledged = [];

function frame(overrides = {}) {
  return {
    type: 'screencast-frame',
    dataBase64: 'AAAA',
    width: 800,
    height: 600,
    pageId: 'p1',
    ackId: nextAckId++,
    ...overrides,
  };
}

/**
 * The worker's end of Chrome's DevTools pipe, as the launcher hands it over: requests out on fd 3, replies in
 * on fd 4, each JSON object followed by a NUL. `Bun.file` because the daemon's ends are non-blocking sockets.
 */
function chromePipe() {
  const writer = Bun.file(3).writer();
  const waiting = new Map();
  let next = 1;
  let closed = false;
  void (async () => {
    const decoder = new TextDecoder();
    let pending = '';
    for await (const chunk of Bun.file(4).stream()) {
      pending += decoder.decode(chunk, { stream: true });
      for (let end = pending.indexOf('\0'); end !== -1; end = pending.indexOf('\0')) {
        const message = JSON.parse(pending.slice(0, end));
        pending = pending.slice(end + 1);
        waiting.get(message.id)?.resolve(message);
        waiting.delete(message.id);
      }
    }
    closed = true;
    for (const call of waiting.values()) call.reject(new Error('Chrome closed its DevTools pipe'));
    waiting.clear();
  })();
  return {
    call(method) {
      if (closed) return Promise.reject(new Error('Chrome closed its DevTools pipe'));
      const id = next++;
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        writer.write(`${JSON.stringify({ id, method })}\0`);
        void writer.flush();
      });
    },
  };
}

// `pipe` is what the agent-browser launcher passes: the handshake is one request Chrome answers over the
// pipe, so this worker says "ready" only when the pipe it was handed really reaches a Chrome.
const cdp = endpoint === 'pipe' ? chromePipe() : undefined;
if (cdp !== undefined) {
  try {
    await cdp.call('Browser.getVersion');
  } catch (error) {
    emit({ type: 'fatal', error: error.message });
    process.exit(1);
  }
}

if (endpoint === 'exit-during-launch') process.exit(7);
if (endpoint === 'fatal') {
  emit({ type: 'fatal', error: 'chromium is missing\nstack line' });
} else if (endpoint === 'overflow-during-launch') {
  process.stdout.write('x'.repeat(4_096));
} else if (endpoint !== 'silent-launch') {
  // Junk before the handshake must not confuse the client.
  process.stdout.write('not json at all\n');
  emit({ type: 'unknown-record' });
  emit({ type: 'ready' });
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf('\n');
    if (newline === -1) return;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.length > 0) handle(JSON.parse(line));
  }
});

/** Secure copy's read; the page id picks the answer. The value is a fixed fake, echoed with what was asked. */
function copyReply(id, params) {
  const page = params?.pageId;
  const read = {
    ok: true,
    value: `fake-${params?.part}-${params?.attribute ?? ''}-${params?.target?.ref ?? params?.target?.selector}`,
    origin: 'https://example.test',
    frameOrigin: 'https://frame.example',
    navigationId: 'loader-1',
  };
  if (page === 'missing') reply(id, true, { read: { ok: false, reason: 'missing' } });
  else if (page === 'garbled') reply(id, true, { read: { ...read, navigationId: 7 } });
  else if (page === 'huge') reply(id, true, { read: { ...read, value: 'x'.repeat(20_000) } });
  else reply(id, true, { read });
}

/** The input bridge's four calls; the page id picks the answer, so one fixture covers each path. */
function inputReply(id, method, params) {
  const page = params?.pageId;
  const facts = {
    kind: 'browser',
    pageId: 'p1',
    origin: 'https://example.test',
    secure: true,
    navigationId: 'loader-1',
    fields: [
      {
        fieldId: 'password',
        frameOrigin: 'https://example.test',
        frameId: 'main',
        backendNodeId: 7,
        field: { tag: 'input', type: 'password' },
        box: { x: 1, y: 2, w: 3, h: 4 },
        visible: true,
      },
    ],
  };
  if (page === 'refuses') {
    reply(id, false, 'the page is gone');
    return;
  }
  if (method === 'inputDocument')
    reply(
      id,
      true,
      page === 'garbled'
        ? { document: {} }
        : page === 'hostless'
          ? { document: { navigationId: 'loader-1' } }
          : { document: { navigationId: 'loader-1', host: 'accounts.example.test' } },
    );
  else if (method === 'inputProbe')
    reply(id, true, { outcome: page === 'garbled' ? 'typed' : page === 'echoes' ? 'shown' : 'hidden' });
  else if (method === 'inputText') reply(id, true, page === 'garbled' ? { text: 5 } : { text: 'Welcome back' });
  else if (method === 'inputObserve')
    reply(
      id,
      true,
      page === 'missing'
        ? { observation: { ok: false, missing: 'password' } }
        : page === 'garbled'
          ? { observation: { ok: true, facts: { kind: 'browser' } } }
          : { observation: { ok: true, facts } },
    );
  // A re-find answers like a look, and also says when several fields could be the one (#B100).
  else if (method === 'inputRefind')
    reply(
      id,
      true,
      page === 'missing'
        ? { observation: { ok: false, missing: 'password' } }
        : page === 'ambiguous'
          ? { observation: { ok: false, ambiguous: 'password' } }
          : page === 'garbled'
            ? { observation: { ok: true, facts: { kind: 'browser' } } }
            : { observation: { ok: true, facts: { ...facts, fields: [{ ...facts.fields[0], backendNodeId: 9 }] } } },
    );
  else if (method === 'inputShot')
    reply(
      id,
      true,
      page === 'garbled'
        ? { shot: { pngBase64: 'not base64!', clip: { x: 0 } } }
        : { shot: { pngBase64: 'iVBORw0KGgo=', clip: { x: 0, y: 0, w: 10, h: 10 } } },
    );
  // The answer is a word; whether the values arrived is told back through the word, never by echoing them.
  else if (method === 'inputType')
    reply(
      id,
      true,
      page === 'garbled'
        ? { outcome: 'maybe' }
        : { outcome: params?.values?.length === 1 && params?.submit === true ? 'typed' : 'target_changed' },
    );
}

function handle({ id, method, params }) {
  if (endpoint === 'bad-location' && method === 'location') {
    reply(id, true, { activePageId: 'p1', pages: [] });
    return;
  }
  if (endpoint === 'no-screencast' && method === 'startScreencast') return;
  if (method.startsWith('input')) {
    inputReply(id, method, params);
    return;
  }
  if (method === 'copyRead') {
    copyReply(id, params);
    return;
  }
  // A request's own argument selects the reply behaviour, so one fixture covers every path.
  switch (params?.url ?? params?.target?.selector ?? params?.selector ?? method) {
    case 'never-replies':
      return;
    case 'refuses':
      reply(id, false, 'click failed\nat locator("#missing")');
      return;
    case 'bad-snapshot':
      reply(id, true, { actedPageId: 'p1', activePageId: '' });
      return;
    case 'no-acted-page':
      reply(id, true, { activePageId: 'p1', pages: [{ id: 'p1', url: 'https://example.test/', title: 'x' }] });
      return;
    case 'overflows':
      process.stdout.write('x'.repeat(4_096));
      return;
    case 'environment':
      // Reported through the snapshot params, so the test reads it back over the real protocol.
      reply(
        id,
        true,
        snapshot(
          method,
          Object.fromEntries(Object.entries(process.env).map(([key, value]) => [key, key === 'PATH' ? 'set' : value])),
        ),
      );
      return;
    case 'crashes':
      process.exit(3);
      return;
    case 'cdp-round-trip':
      // One more request over the pipe AFTER launch: the daemon has closed its copies by now, so an answer
      // proves the pipe runs from this worker to Chrome and through nobody else.
      cdp.call('Browser.getVersion').then(
        message => reply(id, true, snapshot(method, { chrome: message.result.product })),
        error => reply(id, false, error.message),
      );
      return;
    case 'startScreencast':
      // A real worker refuses a viewport it cannot capture.
      if (!params?.width || !params?.height) reply(id, false, 'invalid screencast viewport');
      else reply(id, true, {});
      return;
    case 'ackFrame':
      acknowledged.push(params.ackId);
      reply(id, endpoint !== 'refuses-acks', endpoint === 'refuses-acks' ? 'window closed' : {});
      return;
    case 'acknowledged':
      reply(id, true, snapshot(method, { acks: acknowledged }));
      return;
    case 'emit-frames':
      emit(frame());
      // A frame with no page identity is unusable and must be dropped rather than published.
      emit(frame({ pageId: undefined }));
      emit(frame({ dataBase64: 'BBBB' }));
      reply(id, true, snapshot(method, params));
      return;
    case 'close':
      reply(id, true, {});
      if (endpoint !== 'stubborn-close') process.exit(0);
      return;
    default:
      reply(id, true, snapshot(method, params));
  }
}
