import { randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
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

/** Whether a transcript names `needle`. A file that cannot be read names nothing. */
async function mentions(file: string, needle: string): Promise<boolean> {
  return await Bun.file(file)
    .text()
    .then(text => text.includes(needle))
    .catch(() => false);
}
