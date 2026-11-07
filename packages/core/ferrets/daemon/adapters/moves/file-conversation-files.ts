import { randomUUID } from 'node:crypto';
import { chmod, copyFile, type FileHandle, mkdir, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Harness } from '@ferretry/protocol';
import type { ConversationFilesPort, PriorConversation } from '../../lib/migrate/conversation-carry.ts';
import { claudeProjectDirectory } from '../../lib/session/transcript/claude-path.ts';
import type { CodexRolloutIndex } from '../../lib/session/transcript/index.ts';

/**
 * How many of a folder's newest transcripts the repair reads. A project folder a person has worked
 * in for months holds hundreds; the conversation a broken Restart left behind is among the newest.
 */
const NEWEST = 64;

/**
 * The transcripts a migration carries between logins, on disk.
 *
 * THE COPY IS ATOMIC, through a temporary file beside the target, because the harness that is about to
 * resume the conversation reads this file first: a torn copy is a conversation that resumes with its
 * newest turns missing. It REPLACES an older copy, which is what a session moved away and back again
 * finds there — the conversation went on growing in the other home.
 *
 * A COPY, NEVER A LINK. A hard link would make both logins append to one file, and the login a
 * session left would then hold a conversation it never had.
 */
export class FileConversationFiles implements ConversationFilesPort {
  constructor(
    private readonly rollouts: CodexRolloutIndex,
    private readonly uniqueId: () => string = randomUUID,
  ) {}

  async written(file: string): Promise<boolean> {
    return await stat(file)
      .then(info => info.isFile())
      .catch(() => false);
  }

  async copy(from: string, to: string): Promise<void> {
    await mkdir(dirname(to), { recursive: true, mode: 0o700 });
    const temporary = join(dirname(to), `.${basename(to)}.${this.uniqueId()}.tmp`);
    try {
      await copyFile(from, temporary);
      await chmod(temporary, 0o600);
      await rename(temporary, to);
    } catch (failure) {
      await rm(temporary, { force: true });
      throw failure;
    }
  }

  /**
   * The whole file, or `undefined` when it is missing, unreadable or larger than `maxBytes`. Never a
   * prefix: a transcript cut short would be converted without its newest turns, which are the ones
   * that matter most.
   */
  async read(file: string, maxBytes: number): Promise<string | undefined> {
    const handle = await open(file, 'r').catch(() => undefined);
    if (handle === undefined) return undefined;
    try {
      const { size } = await handle.stat();
      if (size > maxBytes) return undefined;
      const buffer = new Uint8Array(size);
      const { bytesRead } = await handle.read(buffer, 0, size, 0);
      return new TextDecoder().decode(buffer.subarray(0, bytesRead));
    } catch {
      return undefined;
    } finally {
      await handle.close();
    }
  }

  /** Atomic like {@link copy}: the harness about to resume this file must never see half of it. */
  async write(file: string, data: string | Uint8Array): Promise<void> {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = join(dirname(file), `.${basename(file)}.${this.uniqueId()}.tmp`);
    try {
      await writeFile(temporary, data, { mode: 0o600 });
      await rename(temporary, file);
    } catch (failure) {
      await rm(temporary, { force: true });
      throw failure;
    }
  }

  async prior(harness: Harness, home: string, cwd: string, needle: string): Promise<readonly PriorConversation[]> {
    return harness === 'claude' ? await this.claude(home, cwd, needle) : await this.codex(home, needle);
  }

  /** Claude keeps one `<id>.jsonl` per conversation in the working directory's project folder. */
  private async claude(home: string, cwd: string, needle: string): Promise<readonly PriorConversation[]> {
    const folder = join(home, 'projects', claudeProjectDirectory(cwd));
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
    const files = await Promise.all(
      entries
        .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
        .map(async entry => {
          const file = join(folder, entry.name);
          return { file, id: entry.name.slice(0, -'.jsonl'.length), modifiedMs: await modified(file) };
        }),
    );
    const newest = files.toSorted((left, right) => right.modifiedMs - left.modifiedMs).slice(0, NEWEST);
    return await Promise.all(
      newest.map(async found => ({ ...found, mentionsSession: await mentions(found.file, needle) })),
    );
  }

  /** Codex: the rollout index already answers which rollouts carry the session's directory. */
  private async codex(home: string, needle: string): Promise<readonly PriorConversation[]> {
    const candidates = await this.rollouts.candidates(home, needle);
    return await Promise.all(
      candidates.map(async candidate => ({
        id: candidate.id,
        file: candidate.file,
        modifiedMs: await modified(candidate.file),
        mentionsSession: candidate.correlated,
      })),
    );
  }
}

/** Last write in epoch milliseconds; a file that vanished sorts last. */
async function modified(file: string): Promise<number> {
  return await stat(file)
    .then(info => info.mtimeMs)
    .catch(() => 0);
}

/** How much of a transcript a search holds at once. */
const MENTION_CHUNK_BYTES = 1024 * 1024;

/**
 * Whether a transcript names `needle`. A file that cannot be read names nothing.
 *
 * Searched a chunk at a time, never read whole: up to {@link NEWEST} transcripts are searched at once
 * and one of them can be hundreds of megabytes, so a whole read of each was a repair that could take
 * the daemon down. Each chunk keeps the previous one's last bytes, so a mention split across the
 * boundary between two chunks is still found.
 */
async function mentions(file: string, needle: string): Promise<boolean> {
  const wanted = Buffer.from(needle, 'utf8');
  const handle = await open(file, 'r').catch(() => undefined);
  if (handle === undefined) return false;
  try {
    return await search(handle, wanted).catch(() => false);
  } finally {
    await handle.close();
  }
}

async function search(handle: FileHandle, wanted: Buffer): Promise<boolean> {
  const chunk = Buffer.allocUnsafe(MENTION_CHUNK_BYTES + wanted.byteLength);
  let carried = 0;
  let position = 0;
  for (;;) {
    const { bytesRead } = await handle.read(chunk, carried, MENTION_CHUNK_BYTES, position);
    const filled = carried + bytesRead;
    if (chunk.subarray(0, filled).includes(wanted)) return true;
    if (bytesRead === 0) return false;
    carried = Math.min(wanted.byteLength, filled);
    chunk.copy(chunk, 0, filled - carried, filled);
    position += bytesRead;
  }
}
