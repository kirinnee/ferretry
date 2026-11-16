import { Database } from 'bun:sqlite';
import type { HarnessHistoryFiles } from '@ferretry/core-ferrets/contract';
import type { SqliteHandle } from '@ferretry/kernel/contract';
import { ClaudeTranscriptParser } from '../../daemon/reader/lib/transcript/claude.ts';
import { CodexTranscriptParser } from '../../daemon/reader/lib/transcript/codex.ts';
import { PacedTranscriptParser } from '../../daemon/reader/lib/transcript/sliced.ts';

/** A SQLite handle on a private in-memory database: what `StatePort.sqlite` hands a plugin, without the kernel. */
export function memorySqlite(): SqliteHandle & { readonly database: Database } {
  const database = new Database(':memory:');
  return {
    database,
    query: <Row>(sql: string, params: readonly unknown[] = []) =>
      database.query(sql).all(...(params as never[])) as Row[],
    run: (sql, params = []) => ({ changes: database.run(sql, params as never[]).changes }),
    transaction: fn => database.transaction(fn)(),
    close: () => undefined,
  };
}

const encoder = new TextEncoder();

/**
 * An in-memory history tree that counts what is read from it, so a test can prove an update read only what it should. A file
 * is its text and a modification time; a folder exists when a file is below it.
 */
export class MemoryHistory implements HarnessHistoryFiles {
  readonly files = new Map<string, { bytes: Uint8Array; mtimeMs: number }>();
  /** Bytes returned by `read`, in total and per path. */
  bytesRead = 0;
  readonly readByPath = new Map<string, number>();
  private clock = 1_770_000_000_000;

  set(path: string, text: string, mtimeMs?: number): void {
    this.clock += 1000;
    this.files.set(path, { bytes: encoder.encode(text), mtimeMs: mtimeMs ?? this.clock });
  }

  append(path: string, text: string): void {
    const file = this.files.get(path);
    if (file === undefined) throw new Error(`no file ${path}`);
    const added = encoder.encode(text);
    const bytes = new Uint8Array(file.bytes.length + added.length);
    bytes.set(file.bytes);
    bytes.set(added, file.bytes.length);
    this.clock += 1000;
    this.files.set(path, { bytes, mtimeMs: this.clock });
  }

  remove(path: string): void {
    this.files.delete(path);
  }

  resetReads(): void {
    this.bytesRead = 0;
    this.readByPath.clear();
  }

  async entries(directory: string) {
    const prefix = directory === '' ? '' : `${directory}/`;
    const seen = new Map<string, { kind: 'file' | 'directory'; size: number; modifiedMs: number }>();
    for (const [path, file] of this.files) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const name = rest.split('/')[0] as string;
      seen.set(
        name,
        rest.includes('/')
          ? { kind: 'directory', size: 0, modifiedMs: file.mtimeMs }
          : { kind: 'file', size: file.bytes.length, modifiedMs: file.mtimeMs },
      );
    }
    return [...seen].map(([name, entry]) => ({ name, ...entry }));
  }

  async stat(path: string) {
    const file = this.files.get(path);
    return file === undefined ? undefined : { size: file.bytes.length, modifiedMs: file.mtimeMs };
  }

  async read(path: string, offset: number, length: number) {
    const file = this.files.get(path);
    if (file === undefined) return undefined;
    const part = file.bytes.slice(offset, offset + length);
    this.bytesRead += part.length;
    this.readByPath.set(path, (this.readByPath.get(path) ?? 0) + part.length);
    return part;
  }
}

const NO_WAIT = { now: () => 0, yieldToLoop: async (): Promise<void> => undefined };
export const PARSERS = {
  claude: new PacedTranscriptParser(new ClaudeTranscriptParser(), NO_WAIT),
  codex: new PacedTranscriptParser(new CodexTranscriptParser(), NO_WAIT),
};

/** One Claude record. */
export const claudeRecord = (role: 'user' | 'assistant', text: string, at: string, cwd = '/work/app'): string =>
  JSON.stringify({ type: role, cwd, timestamp: at, message: { role, content: text } });

/** One Codex rollout: a `session_meta` and a user message. */
export const codexRollout = (id: string, cwd: string, text: string, at = '2026-10-10T09:00:00.000Z'): string =>
  [
    JSON.stringify({ type: 'session_meta', timestamp: at, payload: { id, cwd } }),
    JSON.stringify({
      type: 'response_item',
      timestamp: at,
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    }),
  ].join('\n') + '\n';
