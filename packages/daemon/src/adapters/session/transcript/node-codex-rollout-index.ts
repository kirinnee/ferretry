import { open, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type {
  CodexRolloutBaseline,
  CodexRolloutCandidate,
  CodexRolloutIndex,
} from '../../../lib/session/transcript/index.ts';

/**
 * The rollouts a Codex home holds, and which of them carry a caller's correlation token.
 *
 * Codex writes one JSONL rollout per session under `<CODEX_HOME>/sessions/`, in date-partitioned
 * directories, and names it itself. The daemon therefore reads two things from each file: the id
 * from its `session_meta` header, and whether the bytes contain the token that proves ownership.
 *
 * EVERY READ IS WINDOWED. A rollout grows without bound while its agent works, and this index is
 * walked once per unresolved session, so reading whole files would make discovery cost proportional
 * to the fleet's total transcript volume. The header is in the first few lines by construction, and
 * the correlation token — the session's own directory, which its opening turn names — appears in
 * the first turn. A tail window is read as well, because a session that compacted may have pushed
 * the opening turn out of the head window but re-states its brief later.
 *
 * NOTHING HERE RANKS OR CHOOSES. It reports what each file is; `selectCodexRollout` decides, and
 * refuses when the evidence does not single one out.
 */

/** The header window: `session_meta` is the first record Codex writes. */
const HEAD_BYTES = 32 * 1024;
/** The tail window, for a rollout whose opening turn has scrolled out of the head. */
const TAIL_BYTES = 256 * 1024;
/** A walk bound, so a home with a pathological number of rollouts cannot stall a discovery. */
const MAX_ROLLOUTS = 4_000;

/** What one rollout was found to be, valid for as long as its size and modification time hold. */
interface RolloutFacts {
  readonly size: number;
  readonly mtimeMs: number;
  readonly id: string | undefined;
  /** Each correlation token asked about, and whether this file's windows contain it. */
  readonly tokens: Map<string, boolean>;
}

interface RolloutMeta {
  readonly id?: string;
  readonly cwd?: string;
}

/** The uuid Codex names a rollout file after, when the header did not answer. */
function idFromFilename(file: string): string | undefined {
  return /([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/iu.exec(basename(file))?.[1];
}

function metaFromHead(head: string): RolloutMeta {
  for (const line of head.split('\n').slice(0, 8)) {
    if (line.trim() === '') continue;
    try {
      const event = JSON.parse(line) as { type?: string; payload?: RolloutMeta };
      if (event.type === 'session_meta' && event.payload !== undefined) return event.payload;
      if (typeof event.payload?.id === 'string') return event.payload;
    } catch {
      // A partially flushed first line is normal on a live rollout; the filename still names it.
    }
  }
  return {};
}

export class NodeCodexRolloutIndex implements CodexRolloutIndex, CodexRolloutBaseline {
  /**
   * What each rollout was found to be, keyed by path and trusted only while its size and modification
   * time are unchanged.
   *
   * A Codex session whose rollout is not attributed yet is discovered again on EVERY transcript read —
   * every session listing, turn tick and live sample — and each discovery read two windows of up to
   * four thousand files: about a gigabyte of reads and decoding per ask, the bulk of it for rollouts
   * that had not changed in weeks. A walk now costs a `stat` per unchanged rollout and reads only the
   * ones that changed. Entries for files a walk no longer finds are dropped with it.
   */
  readonly #facts = new Map<string, RolloutFacts>();
  /**
   * Each directory's rollout-relevant entries, trusted while the directory's own modification time is
   * unchanged — which moves exactly when an entry is added, removed or renamed. A walk then costs one
   * `stat` per directory instead of an open and a full listing of each.
   */
  readonly #directories = new Map<
    string,
    { readonly mtimeMs: number; readonly directories: readonly string[]; readonly files: readonly string[] }
  >();

  /** Every rollout id this home already holds — the baseline a start records before launching. */
  async ids(home: string): Promise<readonly string[]> {
    const ids: string[] = [];
    for (const file of await this.files(home)) {
      const id = (await this.facts(file)).id;
      if (id !== undefined) ids.push(id);
    }
    return ids;
  }

  async candidates(
    home: string,
    correlationToken: string,
    skip: ReadonlySet<string> = new Set(),
  ): Promise<readonly CodexRolloutCandidate[]> {
    const candidates: CodexRolloutCandidate[] = [];
    for (const file of await this.files(home)) {
      // A rollout already known to be one the caller can never choose is not `stat`ed again: on a
      // home of thousands, the rollouts that existed before a session launched are nearly all of them.
      const known = this.#facts.get(file)?.id;
      if (known !== undefined && skip.has(known)) continue;
      const facts = await this.facts(file);
      if (facts.id === undefined) continue;
      let correlated = facts.tokens.get(correlationToken);
      if (correlated === undefined) {
        correlated = await this.contains(file, facts.size, correlationToken);
        facts.tokens.set(correlationToken, correlated);
      }
      candidates.push({ id: facts.id, file, correlated });
    }
    return candidates;
  }

  /**
   * This rollout's facts, read again only when it changed. A rollout that vanished since the walk is
   * still reported by the id its filename carries, exactly as before, and remembered for nothing.
   */
  private async facts(file: string): Promise<RolloutFacts> {
    const info = await stat(file).catch(() => undefined);
    if (info === undefined) {
      this.#facts.delete(file);
      return { size: 0, mtimeMs: 0, id: await this.identify(file), tokens: new Map() };
    }
    const known = this.#facts.get(file);
    if (known !== undefined && known.size === info.size && known.mtimeMs === info.mtimeMs) return known;
    const facts: RolloutFacts = {
      size: info.size,
      mtimeMs: info.mtimeMs,
      id: await this.identify(file),
      tokens: new Map(),
    };
    this.#facts.set(file, facts);
    return facts;
  }

  /** Every `.jsonl` beneath `<home>/sessions`, bounded. */
  private async files(home: string): Promise<readonly string[]> {
    const found: string[] = [];
    const pending = [join(home, 'sessions')];
    while (pending.length > 0 && found.length < MAX_ROLLOUTS) {
      const directory = pending.shift() as string;
      const listing = await this.listing(directory);
      pending.push(...listing.directories);
      found.push(...listing.files);
    }
    const walked = new Set(found);
    const root = join(home, 'sessions');
    for (const file of this.#facts.keys())
      if (file.startsWith(`${root}/`) && !walked.has(file)) this.#facts.delete(file);
    return found;
  }

  /** One directory's subdirectories and rollouts, listed again only when the directory changed. */
  private async listing(
    directory: string,
  ): Promise<{ readonly directories: readonly string[]; readonly files: readonly string[] }> {
    const mtimeMs = (await stat(directory).catch(() => undefined))?.mtimeMs;
    if (mtimeMs === undefined) {
      this.#directories.delete(directory);
      return { directories: [], files: [] };
    }
    const known = this.#directories.get(directory);
    if (known?.mtimeMs === mtimeMs) return known;
    const directories: string[] = [];
    const files: string[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const child = join(directory, entry.name);
      if (entry.isDirectory()) directories.push(child);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(child);
    }
    const listed = { mtimeMs, directories, files };
    this.#directories.set(directory, listed);
    return listed;
  }

  private async identify(file: string): Promise<string | undefined> {
    const head = await this.window(file, 0, HEAD_BYTES);
    return metaFromHead(head ?? '').id ?? idFromFilename(file);
  }

  /** Whether the rollout's head or tail contains the token. */
  private async contains(file: string, size: number, needle: string): Promise<boolean> {
    const head = await this.window(file, 0, HEAD_BYTES);
    if (head?.includes(needle) === true) return true;
    if (size <= HEAD_BYTES) return false;
    const tail = await this.window(file, Math.max(HEAD_BYTES, size - TAIL_BYTES), TAIL_BYTES);
    return tail?.includes(needle) === true;
  }

  /**
   * `length` bytes from `offset`, or nothing when the file is gone.
   *
   * A rollout that disappears between the walk and the read is ordinary — the harness rotates and
   * removes them — so an open that fails is absence rather than an error. A read that fails after a
   * successful open is NOT absence, and it is left to propagate: the resolver's caller degrades a
   * failed transcript read to an empty tail, and swallowing it here would instead report the file
   * as "present and containing nothing", which is a claim the daemon has not earned.
   */
  private async window(file: string, offset: number, length: number): Promise<string | undefined> {
    const handle = await open(file, 'r').catch(() => undefined);
    if (handle === undefined) return undefined;
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
}
