import type { FencedPath, RootHandle, RootsPort } from '@ferretry/kernel/contract';
import type { ConversationFilesPort, PriorConversation } from '../../lib/moves/conversation-carry.ts';
import type { MoveCodexRollouts, TranscriptToolkit } from '../../lib/moves/ports.ts';
import type { Harness } from '../../lib/protocol/session-base.ts';

/**
 * How many of a folder's newest transcripts the repair reads. A project folder a person has worked
 * in for months holds hundreds; the conversation a broken Restart left behind is among the newest.
 */
const NEWEST = 64;

/** The most of a transcript one copy carries. A larger one is refused rather than cut: a half transcript resumes with its newest turns missing. */
const COPY_MAX_BYTES = 2 * 1024 * 1024 * 1024;

/** How much of a transcript a search holds at once. */
const MENTION_CHUNK_BYTES = 1024 * 1024;

/**
 * The transcripts a move carries between logins, through the `harness-history` root.
 *
 * Every path a move names is an ABSOLUTE file inside one login's harness home, so each call finds the home that holds
 * it (the homes the account inventory publishes, `homes()`) and goes through a root fenced to that home alone: a path
 * outside every home is unreadable here, whatever a transcript's provenance claims, and a link that leaves the home
 * is refused by the root, not by this class.
 *
 * THE COPY IS ATOMIC, because the harness that is about to resume the conversation reads this file first: a torn copy
 * is a conversation that resumes with its newest turns missing. The root replaces a file whole (temporary file and
 * rename) and REPLACES an older copy, which is what a session moved away and back again finds there — the
 * conversation went on growing in the other home.
 *
 * A COPY, NEVER A LINK. A hard link would make both logins append to one file, and the login a
 * session left would then hold a conversation it never had.
 */
export class HistoryConversationFiles implements ConversationFilesPort {
  constructor(
    private readonly roots: RootsPort,
    /** Every login's harness home, as published now. */
    private readonly homes: () => Promise<readonly string[]>,
    private readonly rollouts: MoveCodexRollouts,
    private readonly paths: Pick<TranscriptToolkit, 'claudeProjectDirectory'>,
  ) {}

  async written(file: string): Promise<boolean> {
    try {
      const at = await this.locate(file);
      return at !== undefined && (await at.root.stat(at.path))?.kind === 'file';
    } catch {
      return false;
    }
  }

  async copy(from: string, to: string): Promise<void> {
    const source = await this.require(from);
    const bytes = await source.root.readBytes(source.path, COPY_MAX_BYTES);
    await this.writeBytes(to, bytes);
  }

  /**
   * The whole file, or `undefined` when it is missing, unreadable or larger than `maxBytes`. Never a
   * prefix: a transcript cut short would be converted without its newest turns, which are the ones
   * that matter most.
   */
  async read(file: string, maxBytes: number): Promise<string | undefined> {
    try {
      const at = await this.locate(file);
      if (at === undefined) return undefined;
      const info = await at.root.stat(at.path);
      if (info === undefined || info.kind !== 'file' || info.size > maxBytes) return undefined;
      return await at.root.readText(at.path, maxBytes);
    } catch {
      return undefined;
    }
  }

  /** Atomic like {@link copy}: the harness about to resume this file must never see half of it. */
  async write(file: string, data: string | Uint8Array): Promise<void> {
    await this.writeBytes(file, typeof data === 'string' ? new TextEncoder().encode(data) : data);
  }

  async prior(harness: Harness, home: string, cwd: string, needle: string): Promise<readonly PriorConversation[]> {
    return harness === 'claude' ? await this.claude(home, cwd, needle) : await this.codex(home, needle);
  }

  /** Claude keeps one `<id>.jsonl` per conversation in the working directory's project folder. */
  private async claude(home: string, cwd: string, needle: string): Promise<readonly PriorConversation[]> {
    const folder = `${home}/projects/${this.paths.claudeProjectDirectory(cwd)}`;
    const at = await this.locate(folder);
    const entries = at === undefined ? [] : await at.root.entries(at.path).catch(() => []);
    const files = entries
      .filter(entry => entry.kind === 'file' && entry.name.endsWith('.jsonl'))
      .map(entry => ({
        file: `${folder}/${entry.name}`,
        id: entry.name.slice(0, -'.jsonl'.length),
        modifiedMs: Date.parse(entry.modified),
      }));
    const newest = files.toSorted((left, right) => right.modifiedMs - left.modifiedMs).slice(0, NEWEST);
    return await Promise.all(
      newest.map(async found => ({ ...found, mentionsSession: await this.mentions(found.file, needle) })),
    );
  }

  /** Codex: the rollout index already answers which rollouts carry the session's directory. */
  private async codex(home: string, needle: string): Promise<readonly PriorConversation[]> {
    const candidates = await this.rollouts.candidates(home, needle);
    return await Promise.all(
      candidates.map(async candidate => ({
        id: candidate.id,
        file: candidate.file,
        modifiedMs: await this.modified(candidate.file),
        mentionsSession: candidate.correlated,
      })),
    );
  }

  /** Last write in epoch milliseconds; a file that vanished sorts last. */
  private async modified(file: string): Promise<number> {
    try {
      const at = await this.locate(file);
      const info = at === undefined ? undefined : await at.root.stat(at.path);
      return info === undefined ? 0 : Date.parse(info.modified);
    } catch {
      return 0;
    }
  }

  /**
   * Whether a transcript names `needle`. A file that cannot be read names nothing.
   *
   * Searched a chunk at a time, never read whole: up to {@link NEWEST} transcripts are searched at once
   * and one of them can be hundreds of megabytes, so a whole read of each was a repair that could take
   * the daemon down. Each chunk keeps the previous one's last bytes, so a mention split across the
   * boundary between two chunks is still found.
   */
  private async mentions(file: string, needle: string): Promise<boolean> {
    try {
      const at = await this.locate(file);
      if (at === undefined) return false;
      const wanted = Buffer.from(needle, 'utf8');
      let carried: Buffer = Buffer.alloc(0);
      let position = 0;
      for (;;) {
        const chunk = Buffer.from(await at.root.readBytes(at.path, { offset: position, length: MENTION_CHUNK_BYTES }));
        const joined = Buffer.concat([carried, chunk]);
        if (joined.includes(wanted)) return true;
        if (chunk.byteLength === 0) return false;
        carried = joined.subarray(Math.max(0, joined.byteLength - wanted.byteLength));
        position += chunk.byteLength;
      }
    } catch {
      return false;
    }
  }

  private async writeBytes(file: string, bytes: Uint8Array): Promise<void> {
    const at = await this.require(file);
    const folder = file.slice(0, file.lastIndexOf('/'));
    const parent = await this.locate(folder);
    if (parent !== undefined) await parent.root.makeDirectory(parent.path, { mode: 0o700 });
    await at.root.writeBytes(at.path, bytes, { mode: 0o600 });
  }

  private async require(file: string): Promise<{ readonly root: RootHandle; readonly path: FencedPath }> {
    const at = await this.locate(file);
    if (at === undefined) throw new Error(`${file} is not inside a harness home this daemon knows`);
    return at;
  }

  /** The root fenced to the home that holds `file`, and the file's place in it; nothing for a path outside every home. */
  private async locate(file: string): Promise<{ readonly root: RootHandle; readonly path: FencedPath } | undefined> {
    const home = (await this.homes())
      .filter(candidate => file === candidate || file.startsWith(`${candidate.replace(/\/+$/u, '')}/`))
      .toSorted((left, right) => right.length - left.length)[0];
    if (home === undefined) return undefined;
    const root = this.roots.root('harness-history', { subfolder: home });
    const inside = file.slice(home.replace(/\/+$/u, '').length).replace(/^\/+/u, '');
    const resolved = root.resolve(inside === '' ? '.' : inside);
    return resolved.ok ? { root, path: resolved.value } : undefined;
  }
}
