/**
 * The DevTools protocol over Chrome's `--remote-debugging-pipe` — how the browser worker drives the agent
 * browser now that it has no debugging port (`CDP_PIPE_SWITCH`, docs/browser-mode.md).
 *
 * Chrome reads requests on ITS fd 3 and writes replies and events on ITS fd 4, every message one JSON object
 * followed by a NUL byte. The daemon starts Chrome with both ends wired and hands the other ends to the worker
 * as the worker's own fds 3 and 4: the worker WRITES on 3 and READS on 4. Nobody else holds either end, which
 * is the whole point — there is no address another account on the host could connect to.
 *
 * This is the framing and nothing else. The bytes come in through {@link CdpPipeTransport.receive} and go out
 * through the {@link CdpPipeWriter} the worker gives it, so it never touches a file descriptor itself.
 */

/**
 * The worker's first argument when it should drive Chrome over the pipe on its fds 3 and 4. It is the only
 * connection the shipped worker accepts: a URL would mean a listening debugging port.
 */
export const CDP_PIPE_ENDPOINT = 'pipe';
/** The worker's fd Chrome READS requests from (Chrome's own fd 3). */
export const CDP_PIPE_TO_CHROME_FD = 3;
/** The worker's fd Chrome WRITES replies and events to (Chrome's own fd 4). */
export const CDP_PIPE_FROM_CHROME_FD = 4;

/**
 * Ceiling on one NUL-free message from Chrome. Far above the largest real one — a full-page screenshot, whose
 * worker reply is itself capped well below this — so it only ever stops a pipe that has lost its framing from
 * growing one string without bound.
 */
export const CDP_PIPE_MAX_MESSAGE_CHARS = 256 * 1024 * 1024;

/** Where framed requests for Chrome go: the worker's end of Chrome's fd 3. */
export interface CdpPipeWriter {
  /** Queues bytes for Chrome, in order. */
  write(bytes: string): void;
  /** Ends the worker's side of the pipe. Chrome reads end-of-file and shuts itself down. */
  close(): void;
}

/**
 * One Chrome connection, in the shape Playwright's `chromium.connectOverCDP(transport)` takes
 * (`ConnectOverCDPTransport`): Playwright sends with {@link send}, listens with `onmessage`, and learns the
 * connection is gone from `onclose`.
 *
 * The two directions end separately, as the pipe's do. {@link close} ends what the worker sends and leaves the
 * read side to drain, because Chrome answers the end-of-file by closing its own end; `onclose` fires exactly
 * once, when the read side ends — Chrome gone, or its stream broken or out of frame.
 */
export class CdpPipeTransport {
  onmessage?: (message: object) => void;
  onclose?: (reason?: string) => void;
  private buffer = '';
  private readonly decoder = new TextDecoder();
  private sending = true;
  private reading = true;
  private readonly writer: CdpPipeWriter;
  private readonly maxMessageChars: number;

  // Fields assigned by hand, not as parameter properties: the source worker runs this file under Node, whose
  // type stripping refuses them.
  constructor(writer: CdpPipeWriter, maxMessageChars: number = CDP_PIPE_MAX_MESSAGE_CHARS) {
    this.writer = writer;
    this.maxMessageChars = maxMessageChars;
  }

  send(message: object): void {
    // Playwright may still flush a request while it tears the connection down; there is nobody to take it.
    if (!this.sending) return;
    this.writer.write(`${JSON.stringify(message)}\0`);
  }

  close(): void {
    if (!this.sending) return;
    this.sending = false;
    this.writer.close();
  }

  /** Bytes Chrome wrote. A message may arrive in pieces, and one chunk may carry several. */
  receive(chunk: Uint8Array): void {
    if (!this.reading) return;
    // NUL never occurs inside a multi-byte UTF-8 sequence, so splitting the DECODED text is exact.
    this.buffer += this.decoder.decode(chunk, { stream: true });
    for (let end = this.buffer.indexOf('\0'); end !== -1; end = this.buffer.indexOf('\0')) {
      const record = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      const message = parseMessage(record);
      if (message === undefined) {
        this.ended('Chrome sent a DevTools message that is not a JSON object');
        return;
      }
      this.onmessage?.(message);
    }
    if (this.buffer.length > this.maxMessageChars) this.ended('Chrome sent an oversized DevTools message');
  }

  /** Chrome's end of the pipe is gone: it exited, or the read failed (`reason`). */
  ended(reason?: string): void {
    if (!this.reading) return;
    this.reading = false;
    this.buffer = '';
    this.close();
    this.onclose?.(reason);
  }
}

function parseMessage(record: string): object | undefined {
  try {
    const value: unknown = JSON.parse(record);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
