import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BytesTranscriptSource, type TranscriptReadLimits } from '../../daemon/reader/adapters/file-source.ts';
import type {
  BoundedTranscriptRead,
  TranscriptFileInfo,
  TranscriptFileRuntime,
} from '../../daemon/reader/adapters/file-source.ts';
import { HarnessBytesRuntime, type TranscriptBytesHandle } from '../../daemon/reader/adapters/harness-bytes-runtime.ts';
import type { TranscriptParser } from '../../daemon/reader/lib/transcript/types.ts';

/**
 * The real-disk twin of `memory-files.ts`: the same names and semantics (`writeFile` on an existing file REWRITES it
 * in place and keeps its inode, `rename` and `link` keep it, `truncate` extends a file sparsely), over real files in a
 * real temporary folder, read through the production {@link HarnessBytesRuntime} by handles that hold a real file
 * descriptor. The integration tier uses it, so the same scenarios as the unit tier run against an actual file system.
 */

const code = (value: string): Error => Object.assign(new Error(value), { code: value });

export const { mkdtemp, mkdir, writeFile, appendFile, truncate, rename, rm, symlink, link } = {
  /** The memory twin takes a prefix inside its pretend tree; here the folder is always a real one under the OS temp. */
  mkdtemp: async (prefix: string): Promise<string> =>
    await fs.mkdtemp(join(tmpdir(), prefix.replace(/^\/memory\//u, '').replaceAll('/', '-'))),
  mkdir: async (path: string): Promise<void> => {
    await fs.mkdir(path, { recursive: true });
  },
  writeFile: async (path: string, data: string | Uint8Array): Promise<void> => {
    // `writeFile` truncates and rewrites the existing inode, so a held handle still reads the same file.
    await fs.writeFile(path, data);
  },
  appendFile: async (path: string, data: string | Uint8Array): Promise<void> => {
    await fs.appendFile(path, data);
  },
  truncate: async (path: string, size: number): Promise<void> => {
    await fs.truncate(path, size);
  },
  rename: async (from: string, to: string): Promise<void> => {
    await fs.rename(from, to);
  },
  rm: async (path: string, options: { readonly recursive?: boolean; readonly force?: boolean } = {}): Promise<void> => {
    await fs.rm(path, options);
  },
  symlink: async (target: string, path: string): Promise<void> => {
    await fs.symlink(target, path);
  },
  link: async (existing: string, path: string): Promise<void> => {
    await fs.link(existing, path);
  },
};

/** The inode identity the runtime reads a file under: it is what tells a rewritten file from a replaced one. */
function tokenOf(stat: { readonly dev: number | bigint; readonly ino: number | bigint }): string {
  return `disk-${String(stat.dev)}-${String(stat.ino)}`;
}

/** A handle on the file at `path` NOW, holding its descriptor; it is REPLACED once `path` names another file. */
export function handleOf(path: string): TranscriptBytesHandle | undefined {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return undefined;
  }
  const opened = fstatSync(fd);
  if (!opened.isFile()) {
    closeSync(fd);
    return undefined;
  }
  let open = true;
  const still = (): boolean => {
    try {
      const now = statSync(path);
      return now.isFile() && now.ino === opened.ino && now.dev === opened.dev;
    } catch {
      return false;
    }
  };
  return {
    format: 'claude',
    file: tokenOf(opened),
    size: opened.size,
    mtimeMs: opened.mtimeMs,
    read: async (offset, length) => {
      if (!still() || !open) throw Object.assign(new Error('replaced'), { name: 'HarnessTranscriptReplaced' });
      const buffer = new Uint8Array(length);
      const got = readSync(fd, buffer, 0, length, offset);
      return buffer.subarray(0, got);
    },
    stat: async () => {
      if (!still() || !open) return undefined;
      const now = fstatSync(fd);
      return { size: now.size, mtimeMs: now.mtimeMs };
    },
    close: async () => {
      if (!open) return;
      open = false;
      closeSync(fd);
    },
  };
}

/**
 * The production {@link HarnessBytesRuntime}, addressed by PATH over the real disk: each call opens the path, hands the
 * file's handle to the runtime, and reads through it. The tests pass paths; production passes tokens.
 */
export class DiskFileRuntime implements TranscriptFileRuntime {
  readonly inner = new HarnessBytesRuntime();

  /** The token the runtime reads `path` under, or `ENOENT`. */
  async token(path: string): Promise<string> {
    const handle = handleOf(path);
    if (handle === undefined) throw code('ENOENT');
    return await this.inner.adopt(handle);
  }

  async info(path: string): Promise<TranscriptFileInfo | undefined> {
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(path);
    } catch (error) {
      // Only "nothing is there" is an answer; a link loop (ELOOP) and the like are read failures.
      if ((error as { code?: string }).code === 'ENOENT') return undefined;
      throw error;
    }
    if (!stat.isFile()) return { identity: `dir:${path}`, size: 0, modifiedMs: 0, isFile: false };
    return await this.inner.info(await this.token(path));
  }

  async countNewlines(path: string, byteLength: number): Promise<number> {
    return await this.inner.countNewlines(await this.token(path), byteLength);
  }

  async readTrailingLine(path: string, byteLength: number, byteLimit: number): Promise<BoundedTranscriptRead> {
    return await this.inner.readTrailingLine(await this.token(path), byteLength, byteLimit);
  }

  async readRange(path: string, byteOffset: number, byteLength: number): Promise<Uint8Array> {
    return await this.inner.readRange(await this.token(path), byteOffset, byteLength);
  }

  async readFrom(path: string, byteOffset: number, byteLimit: number): Promise<BoundedTranscriptRead> {
    return await this.inner.readFrom(await this.token(path), byteOffset, byteLimit);
  }

  /** Lets every descriptor this runtime holds go. */
  async close(): Promise<void> {
    await this.inner.closeAll();
  }
}

/** A transcript source over `runtime`, with a fixed observation instant and no-op loop pacing (so a test never waits). */
export function newSource(
  parser: TranscriptParser,
  runtime: TranscriptFileRuntime = new DiskFileRuntime(),
  clock: { readonly now?: () => string } = {},
  limits: TranscriptReadLimits = {},
): BytesTranscriptSource {
  return new BytesTranscriptSource(
    parser,
    runtime,
    {
      now: clock.now ?? ((): string => '2026-01-02T03:04:05.000Z'),
      pacing: { now: (): number => performance.now(), yieldToLoop: async (): Promise<void> => undefined },
      sleep: async (milliseconds: number): Promise<void> => {
        await new Promise<void>(resolve => setTimeout(resolve, milliseconds));
      },
    },
    limits,
  );
}
