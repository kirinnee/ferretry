import { constants } from 'node:fs';
import { chmod, type FileHandle, lstat, mkdir, open, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ConnectorCallRecord, ConnectorCallsLog } from '../../../lib/connector/mcp/ports.ts';

/** docs/mcp-connector.md "Storage": rotate to `calls.1.jsonl` at 1 MiB. */
const CALLS_LOG_MAX_BYTES = 1024 * 1024;

/**
 * `<stateHome>/connector/calls.jsonl`: one line per WRITE tool call, `0600` in a `0700` directory.
 *
 * Same discipline as the security log (`FileAuditJournal`): one `O_APPEND` write per line, `O_NOFOLLOW` so a
 * planted link is refused, a non-regular or hard-linked file refused, rotation by `rename` only — a line is
 * never edited, and two files of at most a mebibyte bound the whole thing. The record arrives already redacted
 * (the toolbox does that); this adapter writes what it is given and never sees a token.
 */
export class FileConnectorCallsLog implements ConnectorCallsLog {
  readonly #live: string;
  readonly #rotated: string;
  #writes: Promise<void> = Promise.resolve();

  constructor(
    connectorDirectory: string,
    private readonly maxBytes: number = CALLS_LOG_MAX_BYTES,
  ) {
    this.#live = join(connectorDirectory, 'calls.jsonl');
    this.#rotated = join(connectorDirectory, 'calls.1.jsonl');
  }

  async append(record: ConnectorCallRecord): Promise<void> {
    const write = this.#writes.then(async () => await this.#append(`${JSON.stringify(record)}\n`));
    this.#writes = write.then(
      () => undefined,
      () => undefined,
    );
    await write;
  }

  async #append(line: string): Promise<void> {
    const encoded = Buffer.from(line, 'utf8');
    await mkdir(dirname(this.#live), { recursive: true, mode: 0o700 });
    const size = await this.#size(this.#live);
    if (size > 0 && size + encoded.byteLength > this.maxBytes) await rename(this.#live, this.#rotated);
    const handle = await open(
      this.#live,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600,
    );
    try {
      await assertPlainFile(handle);
      await handle.write(encoded);
      await handle.chmod(0o600);
    } finally {
      await handle.close();
    }
    await chmod(dirname(this.#live), 0o700).catch(() => undefined);
  }

  async #size(path: string): Promise<number> {
    try {
      return (await lstat(path)).size;
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return 0;
      throw error;
    }
  }
}

async function assertPlainFile(handle: FileHandle): Promise<void> {
  const facts = await handle.stat();
  if (!facts.isFile()) throw new Error('the connector calls log path is not a regular file');
  if (facts.nlink > 1) throw new Error('the connector calls log file has a second hard link');
}
