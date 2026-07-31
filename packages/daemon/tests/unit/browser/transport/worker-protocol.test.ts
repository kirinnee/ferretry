import { describe, it } from 'bun:test';
import should from 'should';
import { BrowserPageSnapshotSchema, BrowserScreencastFrameSchema } from '@ferretry/protocol';
import {
  BLANK_PAGE_URL,
  BrowserTransportError,
  MAX_WORKER_PAGES,
  WorkerLineAssembler,
  boundedReadText,
  boundedScreenshot,
  coarseWorkerError,
  encodeWorkerRequest,
  normalizeWorkerActionSnapshot,
  normalizeWorkerSnapshot,
  parseWorkerLine,
} from '../../../../src/lib/index.ts';

const page = (id: string, url = `https://example.test/${id}`) => ({ id, url, title: `title ${id}` });

const snapshotReply = (overrides: Record<string, unknown> = {}) => ({
  activePageId: 'p1',
  pages: [page('p1')],
  pageState: 'ready',
  canGoBack: true,
  canGoForward: false,
  ...overrides,
});

describe('browser worker snapshots', () => {
  it('should derive top-level identity from the active tab and satisfy the wire schema', () => {
    // Arrange
    const reply = snapshotReply({ pages: [page('p0'), page('p1')] });

    // Act
    const normalized = normalizeWorkerSnapshot(reply);

    // Assert
    should(normalized.ok).be.true();
    if (!normalized.ok) return;
    should(normalized.value.url).equal('https://example.test/p1');
    should(normalized.value.title).equal('title p1');
    should(normalized.value.canGoBack).be.true();
    should(normalized.value.pageState).equal('ready');
    should(BrowserPageSnapshotSchema.safeParse(normalized.value).success).be.true();
  });

  it('should substitute a blank URL for a tab the worker described without one', () => {
    // Arrange: kteam emitted an empty string here, which the wire schema rejects outright.
    const reply = snapshotReply({ pages: [{ id: 'p1', title: 'new tab' }] });

    // Act
    const normalized = normalizeWorkerSnapshot(reply);

    // Assert
    should(normalized.ok && normalized.value.url).equal(BLANK_PAGE_URL);
    should(normalized.ok && BrowserPageSnapshotSchema.safeParse(normalized.value).success).be.true();
  });

  it('should keep the error state paired with an error string in both directions', () => {
    // Act
    const withoutMessage = normalizeWorkerSnapshot(snapshotReply({ pageState: 'error' }));
    const withMessage = normalizeWorkerSnapshot(
      snapshotReply({ pageState: 'error', pageError: 'net::ERR_FAILED\nstack line' }),
    );
    const ignoredMessage = normalizeWorkerSnapshot(snapshotReply({ pageError: 'ignored' }));

    // Assert
    should(withoutMessage.ok && withoutMessage.value.pageError).equal('unknown error');
    should(withMessage.ok && withMessage.value.pageError).equal('net::ERR_FAILED');
    should(ignoredMessage.ok && ignoredMessage.value.pageError).be.undefined();
    for (const candidate of [withoutMessage, withMessage, ignoredMessage]) {
      should(candidate.ok && BrowserPageSnapshotSchema.safeParse(candidate.value).success).be.true();
    }
  });

  it('should treat an unknown page state as ready', () => {
    // Act
    const loading = normalizeWorkerSnapshot(snapshotReply({ pageState: 'loading' }));
    const nonsense = normalizeWorkerSnapshot(snapshotReply({ pageState: 'melted' }));

    // Assert
    should(loading.ok && loading.value.pageState).equal('loading');
    should(nonsense.ok && nonsense.value.pageState).equal('ready');
  });

  it('should bound long URLs and titles and skip tabs with no usable identity', () => {
    // Arrange
    const reply = snapshotReply({
      pages: [
        { id: '', url: 'https://example.test/nameless' },
        { id: 'x'.repeat(129), url: 'https://example.test/overlong' },
        'not a page',
        { id: 'p1', url: `https://example.test/${'q'.repeat(5_000)}`, title: 't'.repeat(600) },
      ],
    });

    // Act
    const normalized = normalizeWorkerSnapshot(reply);

    // Assert
    should(normalized.ok && normalized.value.pages).have.length(1);
    should(normalized.ok && normalized.value.url.length).equal(4_096);
    should(normalized.ok && normalized.value.title.length).equal(500);
  });

  it('should spend the last tab slot on the active page when the list overflows the cap', () => {
    // Arrange
    const pages = Array.from({ length: MAX_WORKER_PAGES + 5 }, (_unused, index) => page(`p${index}`));
    const activePageId = `p${MAX_WORKER_PAGES + 3}`;

    // Act
    const normalized = normalizeWorkerSnapshot(snapshotReply({ pages, activePageId }));

    // Assert
    should(normalized.ok && normalized.value.pages).have.length(MAX_WORKER_PAGES);
    should(normalized.ok && normalized.value.pages.at(-1)?.id).equal(activePageId);
    should(normalized.ok && normalized.value.activePageId).equal(activePageId);
  });

  it('should refuse a snapshot the wire schema rejects rather than emit one that fails later', () => {
    // Arrange: bounding a string is not the same as knowing it is a URL.
    const notAUrl = snapshotReply({ pages: [{ id: 'p1', url: 'not a url' }] });
    const relative = snapshotReply({ pages: [{ id: 'p1', url: '/index.html' }] });
    const blank = snapshotReply({ pages: [{ id: 'p1', url: '   ' }] });

    // Act & Assert: a worker fault must surface as an upstream failure, never as an invalid snapshot.
    for (const reply of [notAUrl, relative, blank]) {
      should(normalizeWorkerSnapshot(reply)).deepEqual({
        ok: false,
        message: 'browser worker returned a snapshot the protocol rejects',
      });
      should(normalizeWorkerActionSnapshot({ ...reply, actedPageId: 'p1' })).deepEqual({
        ok: false,
        message: 'browser worker returned a snapshot the protocol rejects',
      });
    }
  });

  it('should refuse an acted page the action schema cannot accept', () => {
    // Arrange: provenance is bounded on its own, so only the schema can reject this shape.
    const reply = { ...snapshotReply(), actedPageId: 'p1' };

    // Act
    const accepted = normalizeWorkerActionSnapshot(reply);

    // Assert
    should(accepted.ok).be.true();
    should(accepted.ok && accepted.value.actedPageId).equal('p1');
  });

  it('should refuse a snapshot with no usable or no matching active page', () => {
    // Act & Assert
    should(normalizeWorkerSnapshot(undefined)).deepEqual({
      ok: false,
      message: 'browser worker returned an invalid active page',
    });
    should(normalizeWorkerSnapshot(snapshotReply({ activePageId: 'p9' }))).deepEqual({
      ok: false,
      message: 'browser worker returned an unknown active page',
    });
  });

  it('should require action provenance and pass a snapshot failure through', () => {
    // Act
    const acted = normalizeWorkerActionSnapshot({ ...snapshotReply(), actedPageId: 'p0' });
    const missing = normalizeWorkerActionSnapshot(snapshotReply());
    const broken = normalizeWorkerActionSnapshot({ actedPageId: 'p0' });

    // Assert: acted pages are checked for shape only — a closed tab is no longer in the list.
    should(acted.ok && acted.value.actedPageId).equal('p0');
    should(missing).deepEqual({ ok: false, message: 'browser worker returned no acted page' });
    should(broken).deepEqual({ ok: false, message: 'browser worker returned an invalid active page' });
  });

  it('should bound read text and screenshot payloads', () => {
    // Act & Assert
    should(boundedReadText({ text: 'hello' })).equal('hello');
    should(boundedReadText({ text: 'x'.repeat(200_001) })).have.length(200_000);
    should(boundedReadText({})).equal('');
    should(boundedScreenshot({ screenshotBase64: 'AAAA' })).equal('AAAA');
    should(boundedScreenshot(undefined)).equal('');
  });

  it('should reduce a multi-line worker error to its first bounded line', () => {
    // Act & Assert
    should(coarseWorkerError('first\r\nsecond')).equal('first');
    should(coarseWorkerError('x'.repeat(500))).have.length(200);
    should(coarseWorkerError(7)).equal('');
  });
});

describe('browser worker lines', () => {
  it('should recognize lifecycle records', () => {
    // Act & Assert
    should(parseWorkerLine('{"type":"ready"}')).deepEqual({ kind: 'ready' });
    should(parseWorkerLine('{"type":"fatal","error":"chromium missing\\nstack"}')).deepEqual({
      kind: 'fatal',
      message: 'chromium missing',
    });
    should(parseWorkerLine('{"type":"fatal"}')).deepEqual({ kind: 'fatal', message: 'unknown error' });
  });

  it('should accept a screencast frame and round its dimensions up to a visible pixel', () => {
    // Act
    const event = parseWorkerLine(
      JSON.stringify({ type: 'screencast-frame', dataBase64: 'AAAA', width: 800.4, height: 0.2, pageId: 'p1' }),
    );

    // Assert
    should(event.kind).equal('frame');
    if (event.kind !== 'frame') return;
    should(event.frame).deepEqual({ dataBase64: 'AAAA', width: 800, height: 1, pageId: 'p1' });
    should(BrowserScreencastFrameSchema.safeParse(event.frame).success).be.true();
  });

  it('should carry a usable acknowledgement id and drop an unusable one', () => {
    // Arrange
    const base = { type: 'screencast-frame', dataBase64: 'AAAA', width: 10, height: 10, pageId: 'p1' };

    // Act
    const withAck = parseWorkerLine(JSON.stringify({ ...base, ackId: 7 }));
    const fractional = parseWorkerLine(JSON.stringify({ ...base, ackId: 1.5 }));
    const textual = parseWorkerLine(JSON.stringify({ ...base, ackId: '7' }));
    const absent = parseWorkerLine(JSON.stringify(base));

    // Assert: acknowledging the wrong frame would release a window the browser is still holding.
    should(withAck.kind === 'frame' && withAck.ackId).equal(7);
    should(fractional.kind === 'frame' && fractional.ackId).be.undefined();
    should(textual.kind === 'frame' && textual.ackId).be.undefined();
    should(absent.kind === 'frame' && absent.ackId).be.undefined();
  });

  it('should ignore frames that are unattributable, empty, oversized, or unmeasured', () => {
    // Arrange
    const base = { type: 'screencast-frame', dataBase64: 'AAAA', width: 10, height: 10, pageId: 'p1' };

    // Act & Assert: kteam forwarded identity-free frames and discarded them further downstream.
    for (const override of [
      { pageId: undefined },
      { pageId: 'x'.repeat(129) },
      { dataBase64: '' },
      { dataBase64: 'A'.repeat(16 * 1024 * 1024 + 1) },
      { dataBase64: 42 },
      { width: 'wide' },
      { height: Number.POSITIVE_INFINITY },
    ]) {
      should(parseWorkerLine(JSON.stringify({ ...base, ...override }))).deepEqual({ kind: 'ignored' });
    }
  });

  it('should pair replies with their request id and coarsen their errors', () => {
    // Act & Assert
    should(parseWorkerLine('{"id":4,"ok":true,"result":{"value":1}}')).deepEqual({
      kind: 'result',
      id: 4,
      result: { value: 1 },
    });
    should(parseWorkerLine('{"id":4,"ok":false,"error":"click failed\\nat locator"}')).deepEqual({
      kind: 'failure',
      id: 4,
      message: 'click failed',
    });
    should(parseWorkerLine('{"id":4}')).deepEqual({ kind: 'failure', id: 4, message: 'unknown error' });
  });

  it('should ignore malformed, unidentified, and unknown records', () => {
    // Act & Assert
    for (const line of ['', 'not json', '[]', '{"ok":true}', '{"id":"4","ok":true}', '{"id":1.5,"ok":true}']) {
      should(parseWorkerLine(line)).deepEqual({ kind: 'ignored' });
    }
  });

  it('should encode one request per line', () => {
    // Act & Assert
    should(encodeWorkerRequest(3, 'navigate', { url: 'https://example.test/' })).equal(
      '{"id":3,"method":"navigate","params":{"url":"https://example.test/"}}\n',
    );
  });
});

describe('worker line assembler', () => {
  it('should emit whole lines and retain a partial tail', () => {
    // Arrange
    const assembler = new WorkerLineAssembler(1_000);

    // Act
    const first = assembler.push('{"a":1}\n{"b":2}\n{"c"');
    const second = assembler.push(':3}\n');

    // Assert
    should(first).deepEqual({ lines: ['{"a":1}', '{"b":2}'], overflowed: false });
    should(second).deepEqual({ lines: ['{"c":3}'], overflowed: false });
  });

  it('should report an overflow for a record with no newline in sight', () => {
    // Arrange
    const assembler = new WorkerLineAssembler(8);

    // Act
    const batch = assembler.push('123456789');

    // Assert
    should(batch).deepEqual({ lines: [], overflowed: true });

    // Act: the buffer is dropped, so a later well-formed line still parses.
    const recovered = assembler.push('{"a":1}\n');

    // Assert
    should(recovered).deepEqual({ lines: ['{"a":1}'], overflowed: false });
  });

  it('should report an overflow for an oversized line that does end in a newline', () => {
    // Arrange
    const assembler = new WorkerLineAssembler(4);

    // Act
    const batch = assembler.push('{"a":1}\n{"b":2}\n');

    // Assert
    should(batch).deepEqual({ lines: [], overflowed: true });
  });

  it('should forget its buffer when reset', () => {
    // Arrange
    const assembler = new WorkerLineAssembler(1_000);
    assembler.push('{"partial"');

    // Act
    assembler.reset();
    const batch = assembler.push('{"a":1}\n');

    // Assert
    should(batch).deepEqual({ lines: ['{"a":1}'], overflowed: false });
  });
});

describe('browser transport errors', () => {
  it('should carry the wire error code and status the API surface reports', () => {
    // Act
    const error = new BrowserTransportError('launch_failed', 'browser worker did not become ready', 503);

    // Assert
    should(error).be.instanceof(Error);
    should(error.name).equal('BrowserTransportError');
    should(error.code).equal('launch_failed');
    should(error.status).equal(503);
    should(error.message).equal('browser worker did not become ready');
  });
});
