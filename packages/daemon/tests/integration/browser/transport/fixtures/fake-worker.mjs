// A scriptable stand-in for the real browser worker: it speaks the same JSON-lines protocol with no
// browser behind it, so the client's framing, timeouts, and lifecycle can be tested for real.
//
// The endpoint argument selects a launch behaviour; individual request methods select reply
// behaviours. Nothing here touches the network, a browser, or any state outside this process.

const endpoint = process.argv[2] ?? 'ready';

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

function frame(overrides = {}) {
  return { type: 'screencast-frame', dataBase64: 'AAAA', width: 800, height: 600, pageId: 'p1', ...overrides };
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

function handle({ id, method, params }) {
  if (endpoint === 'bad-location' && method === 'location') {
    reply(id, true, { activePageId: 'p1', pages: [] });
    return;
  }
  if (endpoint === 'no-screencast' && method === 'startScreencast') return;
  // A request's own argument selects the reply behaviour, so one fixture covers every path.
  switch (params?.url ?? params?.selector ?? method) {
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
    case 'crashes':
      process.exit(3);
      return;
    case 'startScreencast':
      reply(id, true, {});
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
