/**
 * Reading a JSONL state file: one JSON document per line, each carrying its own `format`. The line scan is today's
 * journal scanner with the session's event shape taken out — it keeps the two properties that matter: a record has a
 * size cap, so one huge or torn line cannot hold memory, and a crash that left half a record at the end of the file
 * is told apart from a bad record in the middle.
 *
 * Pure: bytes in, lines out. {@link JsonlScanner} takes the bytes a chunk at a time (a boot check of a journal of
 * any size holds one record, not the file); {@link scanJsonl} is the same scanner fed one buffer.
 */

/** Maximum encoded size of one record: a line excluding its newline. The appender enforces the same bound. */
export const MAX_JSONL_RECORD_BYTES = 1 << 20; // 1 MiB

export class JsonlRecordTooLargeError extends Error {
  constructor(
    readonly byteLength: number,
    readonly maxBytes: number,
  ) {
    super(`record of ${byteLength} bytes exceeds the maximum of ${maxBytes} bytes`);
    this.name = 'JsonlRecordTooLargeError';
  }
}

/** Throws when an encoded record exceeds the cap, so an append can never write what a read would refuse. */
export function assertRecordSize(encoded: string, maxBytes: number = MAX_JSONL_RECORD_BYTES): void {
  const byteLength = Buffer.byteLength(encoded, 'utf8');
  if (byteLength > maxBytes) throw new JsonlRecordTooLargeError(byteLength, maxBytes);
}

interface JsonlRecord {
  /** 1-based line number. */
  readonly line: number;
  readonly byteOffset: number;
  readonly value: unknown;
}

interface JsonlProblem {
  readonly line: number;
  readonly byteOffset: number;
  readonly message: string;
}

export interface JsonlScan {
  readonly records: readonly JsonlRecord[];
  readonly problems: readonly JsonlProblem[];
  /**
   * The last line had no newline and did not parse: a crash cut an append short. It is NOT in `problems` — nothing
   * was ever acknowledged for it — and the next append closes it with a newline first.
   */
  readonly tornTail: boolean;
}

export interface JsonlScanOptions {
  readonly maxRecordBytes?: number;
}

/** What a scan reports, one call per line, in file order. */
export interface JsonlSink {
  record(record: JsonlRecord): void;
  problem(problem: JsonlProblem): void;
  /** The last line had no newline and did not parse (see {@link JsonlScan.tornTail}). */
  tornTail(): void;
}

function decodeLine(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function concat(parts: readonly Uint8Array[], total: number): Uint8Array {
  const joined = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.byteLength;
  }
  return joined;
}

/**
 * The line scan as a state machine fed one chunk at a time, so a file of any size is judged holding at most one
 * record (the cap) plus the chunk in hand. `push` takes bytes the caller may reuse afterwards: a partial line is
 * copied. A line over the cap is counted, never held. {@link scanJsonl} is this scanner fed one whole buffer, so
 * both agree on every verdict.
 */
export class JsonlScanner {
  readonly #sink: JsonlSink;
  readonly #cap: number;
  #held: Uint8Array[] = [];
  /** Bytes of the line in progress, held or not. */
  #lineBytes = 0;
  #line = 1;
  #lineOffset = 0;

  constructor(sink: JsonlSink, options: JsonlScanOptions = {}) {
    this.#sink = sink;
    this.#cap = options.maxRecordBytes ?? MAX_JSONL_RECORD_BYTES;
  }

  push(chunk: Uint8Array): void {
    let from = 0;
    for (let index = chunk.indexOf(0x0a); index >= 0; index = chunk.indexOf(0x0a, from)) {
      this.#finish(chunk.subarray(from, index), true);
      from = index + 1;
    }
    if (from < chunk.byteLength) this.#hold(chunk.subarray(from));
  }

  /** The end of the file: a last line with no newline is judged as a possibly torn one. */
  end(): void {
    if (this.#lineBytes > 0) this.#finish(new Uint8Array(), false);
  }

  #hold(rest: Uint8Array): void {
    this.#lineBytes += rest.byteLength;
    if (this.#lineBytes > this.#cap) this.#held = [];
    else this.#held.push(rest.slice());
  }

  #finish(rest: Uint8Array, terminated: boolean): void {
    const total = this.#lineBytes + rest.byteLength;
    const line = this.#line;
    const byteOffset = this.#lineOffset;
    const held = this.#held;
    this.#held = [];
    this.#lineBytes = 0;
    this.#line += 1;
    this.#lineOffset += total + 1;
    if (total > this.#cap) {
      this.#sink.problem({
        line,
        byteOffset,
        message: `record exceeds the maximum encoded size of ${this.#cap} bytes`,
      });
      return;
    }
    const raw = held.length === 0 ? rest : concat([...held, rest], total);
    const text = decodeLine(raw);
    if (text === undefined) {
      if (terminated) this.#sink.problem({ line, byteOffset, message: 'record is not valid UTF-8' });
      else this.#sink.tornTail();
      return;
    }
    if (text.trim().length === 0) return;
    try {
      this.#sink.record({ line, byteOffset, value: JSON.parse(text) });
    } catch {
      if (terminated) this.#sink.problem({ line, byteOffset, message: 'record is not valid JSON' });
      else this.#sink.tornTail();
    }
  }
}

export function scanJsonl(bytes: Uint8Array, options: JsonlScanOptions = {}): JsonlScan {
  const records: JsonlRecord[] = [];
  const problems: JsonlProblem[] = [];
  let tornTail = false;
  const scanner = new JsonlScanner(
    {
      record: record => void records.push(record),
      problem: problem => void problems.push(problem),
      tornTail: () => {
        tornTail = true;
      },
    },
    options,
  );
  scanner.push(bytes);
  scanner.end();
  return { records, problems, tornTail };
}
