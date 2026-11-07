/**
 * Reading a JSONL state file: one JSON document per line, each carrying its own `format`. The line scan is today's
 * journal scanner with the session's event shape taken out — it keeps the two properties that matter: a record has a
 * size cap, so one huge or torn line cannot hold memory, and a crash that left half a record at the end of the file
 * is told apart from a bad record in the middle.
 *
 * Pure: bytes in, lines out.
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

export interface JsonlRecord {
  /** 1-based line number. */
  readonly line: number;
  readonly byteOffset: number;
  readonly value: unknown;
}

export interface JsonlProblem {
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

function decodeLine(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

export function scanJsonl(bytes: Uint8Array, options: JsonlScanOptions = {}): JsonlScan {
  const cap = options.maxRecordBytes ?? MAX_JSONL_RECORD_BYTES;
  const records: JsonlRecord[] = [];
  const problems: JsonlProblem[] = [];
  let tornTail = false;
  let line = 1;
  let lineStart = 0;

  const inspect = (lineEnd: number, terminated: boolean): void => {
    const raw = bytes.subarray(lineStart, lineEnd);
    const byteOffset = lineStart;
    if (raw.byteLength > cap) {
      problems.push({ line, byteOffset, message: `record exceeds the maximum encoded size of ${cap} bytes` });
      return;
    }
    const text = decodeLine(raw);
    if (text === undefined) {
      if (terminated) problems.push({ line, byteOffset, message: 'record is not valid UTF-8' });
      else tornTail = true;
      return;
    }
    if (text.trim().length === 0) return;
    try {
      records.push({ line, byteOffset, value: JSON.parse(text) });
    } catch {
      if (terminated) problems.push({ line, byteOffset, message: 'record is not valid JSON' });
      else tornTail = true;
    }
  };

  for (let index = bytes.indexOf(0x0a); index >= 0; index = bytes.indexOf(0x0a, index + 1)) {
    inspect(index, true);
    lineStart = index + 1;
    line += 1;
  }
  if (lineStart < bytes.byteLength) inspect(bytes.byteLength, false);
  return { records, problems, tornTail };
}
