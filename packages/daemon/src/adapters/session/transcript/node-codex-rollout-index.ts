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
/**
 * How long a directory must have been left alone before its listing is trusted to stay current.
 *
 * A directory's modification time has a granularity, so an entry created in the same tick as the
 * listing leaves the time unchanged and would hide behind it. A listing taken that close to the last
 * change is used once and listed again on the next walk; one taken after the directory settled is
 * reused until the directory's identity or time moves.
 */
const SETTLED_MS = 2_000;
/**
 * How many of the newest day directories {@link NodeCodexRolloutIndex.frontier} names. Two, so a session
 * that launched just before midnight is still heard while its first turn lands in yesterday's directory.
 */
const FRONTIER_DAYS = 2;

const SKIP_NOTHING: ReadonlySet<string> = new Set();

/** What one rollout was found to be, valid for as long as its size and modification time hold. */
interface RolloutFacts {
  readonly size: number;
  readonly mtimeMs: number;
  readonly id: string | undefined;
  /**
   * Whether the id came from the `session_meta` header. A header names its file for the life of the
   * path, so a settled id is never read again; an id taken from the filename because the header was
   * still partially flushed is read again the next time the file is found changed.
   */
  readonly settled: boolean;
  /** Each correlation token asked about, and whether this file's windows contain it. */
  readonly tokens: Map<string, boolean>;
}

/** One directory's entries, valid for as long as the directory's identity and modification time hold. */
interface DirectoryListing {
  readonly ino: number;
  readonly mtimeMs: number;
  /** Whether the directory had settled when it was listed, so an unchanged time proves an unchanged listing. */
  readonly trusted: boolean;
  readonly directories: readonly string[];
  readonly files: readonly string[];
}

interface RolloutIdentity {
  readonly id: string | undefined;
  readonly settled: boolean;
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

const sameEntries = (a: DirectoryListing, b: DirectoryListing): boolean =>
  a.directories.length === b.directories.length &&
  a.files.length === b.files.length &&
  a.directories.every((name, index) => b.directories[index] === name) &&
  a.files.every((name, index) => b.files[index] === name);

export class NodeCodexRolloutIndex implements CodexRolloutIndex, CodexRolloutBaseline {
  /**
   * What each rollout was found to be, keyed by path and trusted only while its size and modification
   * time are unchanged.
   *
   * A Codex session whose rollout is not attributed yet is discovered again on EVERY transcript read —
   * every session listing, turn tick and live sample — and each discovery read two windows of up to
   * four thousand files: about a gigabyte of reads and decoding per ask, the bulk of it for rollouts
   * that had not changed in weeks. A walk now reads only the ones that changed, and never so much as
   * `stat`s a rollout whose id the caller skips. Entries for files a walk no longer finds are dropped
   * with it.
   */
  readonly #facts = new Map<string, RolloutFacts>();

  /**
   * Each directory's last listing, keyed by path.
   *
   * The walk used to `readdir` every directory of the home on every discovery. A new rollout appears
   * as a new entry in its dated directory, and a new dated directory as a new entry in its parent —
   * both move the directory's modification time — so a walk now costs one `stat` per directory and
   * lists again only the ones that moved, or that {@link invalidate} named.
   */
  readonly #listings = new Map<string, DirectoryListing>();

  /** How many times each home's listing has been seen to change, for {@link changes}. */
  readonly #changes = new Map<string, number>();

  /** The walk in flight for each home, so concurrent askers share one pass over the directories. */
  readonly #walking = new Map<string, Promise<readonly string[]>>();

  /** Rollouts opened to be read, for a caller that accounts for what a walk cost. */
  #opened = 0;

  /** `now` dates a listing against its directory's modification time; see {@link SETTLED_MS}. */
  constructor(private readonly now: () => number = Date.now) {}

  /** Every rollout id this home already holds — the baseline a start records before launching. */
  async ids(home: string): Promise<readonly string[]> {
    const ids: string[] = [];
    for (const file of await this.files(home)) {
      const known = this.#facts.get(file);
      const id = known?.settled === true ? known.id : (await this.facts(file)).id;
      if (id !== undefined) ids.push(id);
    }
    return ids;
  }

  async candidates(
    home: string,
    correlationToken: string,
    skip: ReadonlySet<string> = SKIP_NOTHING,
  ): Promise<readonly CodexRolloutCandidate[]> {
    const candidates: CodexRolloutCandidate[] = [];
    for (const file of await this.files(home)) {
      // A skipped rollout can never be chosen — the baseline was there before this session launched —
      // so once its id is known it is neither `stat`ed nor read again, whatever it does next. On a home
      // of thousands, the baseline is nearly all of them.
      const known = this.#facts.get(file);
      if (known?.id !== undefined && skip.has(known.id)) continue;
      const facts = await this.facts(file);
      if (facts.id === undefined || skip.has(facts.id)) continue;
      let correlated = facts.tokens.get(correlationToken);
      if (correlated === undefined) {
        correlated = await this.contains(file, facts.size, correlationToken);
        facts.tokens.set(correlationToken, correlated);
      }
      candidates.push({ id: facts.id, file, correlated });
    }
    return candidates;
  }

  /** How many times a walk has seen this home's listing change: a new or removed rollout or directory. */
  changes(home: string): number {
    return this.#changes.get(home) ?? 0;
  }

  /** How many rollouts this index has opened to read, ever. */
  get opened(): number {
    return this.#opened;
  }

  /**
   * The directories a new rollout of this home would appear in, as the last walk found them: `sessions`
   * itself, then each directory on the way to the {@link FRONTIER_DAYS} newest day directories, and those.
   *
   * Codex files a rollout under the date its session started (`sessions/YYYY/MM/DD`), so a session
   * launched now writes into today's directory, or into a new one that appears in its month's — or a new
   * month in its year's, a new year in `sessions`. A watch on exactly these hears every one of those
   * arrivals, and none of the hundreds of older days that only ever grow by an old session resuming.
   * Before any walk, only `sessions` is named.
   */
  frontier(home: string): readonly string[] {
    const root = join(home, 'sessions');
    const inHome = (path: string): boolean => path.startsWith(`${root}/`);
    const days = [...this.#listings.entries()]
      .filter(([directory, listing]) => inHome(directory) && listing.directories.length === 0)
      .map(([directory]) => directory)
      .sort()
      .slice(-FRONTIER_DAYS);
    const frontier = new Set([root]);
    for (const day of days) {
      const parts = day.slice(root.length + 1).split('/');
      for (let depth = 1; depth <= parts.length; depth += 1) frontier.add(join(root, ...parts.slice(0, depth)));
    }
    return [...frontier];
  }

  /**
   * Somebody saw this directory's entries change — a file-system watcher, say — so its listing is
   * read again on the next walk however its modification time looks, and the home counts a change.
   *
   * The `stat` a walk spends per directory is how the index notices on its own; a caller that is
   * told directly can say so here instead, and a later caller may stop the walk from needing to ask.
   */
  invalidate(directory: string): void {
    const known = this.#listings.get(directory);
    if (known !== undefined) this.#listings.set(directory, { ...known, trusted: false });
    for (const home of this.#changes.keys()) {
      const root = join(home, 'sessions');
      if (directory === root || directory.startsWith(`${root}/`)) this.changed(home);
    }
  }

  /**
   * This rollout's facts, read again only when it changed. A rollout that vanished since the walk is
   * still reported by the id its filename carries, exactly as before, and remembered for nothing.
   */
  private async facts(file: string): Promise<RolloutFacts> {
    const info = await stat(file).catch(() => undefined);
    const known = this.#facts.get(file);
    if (info === undefined) {
      this.#facts.delete(file);
      return { size: 0, mtimeMs: 0, ...(await this.identify(file)), tokens: new Map() };
    }
    if (known !== undefined && known.size === info.size && known.mtimeMs === info.mtimeMs) return known;
    const facts: RolloutFacts = {
      size: info.size,
      mtimeMs: info.mtimeMs,
      ...(known?.settled === true ? { id: known.id, settled: true } : await this.identify(file)),
      tokens: new Map(),
    };
    this.#facts.set(file, facts);
    return facts;
  }

  /** Every `.jsonl` beneath `<home>/sessions`, bounded. */
  private async files(home: string): Promise<readonly string[]> {
    const running = this.#walking.get(home);
    if (running !== undefined) return await running;
    const walk = this.walk(home).finally(() => this.#walking.delete(home));
    this.#walking.set(home, walk);
    return await walk;
  }

  private async walk(home: string): Promise<readonly string[]> {
    const root = join(home, 'sessions');
    const found: string[] = [];
    const visited = new Set<string>();
    const pending = [root];
    let changed = !this.#changes.has(home);
    while (pending.length > 0 && found.length < MAX_ROLLOUTS) {
      const directory = pending.shift() as string;
      visited.add(directory);
      const { listing, moved } = await this.list(directory);
      changed ||= moved;
      for (const name of listing.directories) pending.push(join(directory, name));
      for (const name of listing.files) found.push(join(directory, name));
    }
    const inHome = (path: string): boolean => path === root || path.startsWith(`${root}/`);
    for (const directory of this.#listings.keys())
      if (inHome(directory) && !visited.has(directory)) this.#listings.delete(directory);
    const walked = new Set(found);
    for (const file of this.#facts.keys()) if (inHome(file) && !walked.has(file)) this.#facts.delete(file);
    if (changed) this.changed(home);
    return found;
  }

  /** One directory's entries, from the last listing while the directory has not moved. */
  private async list(directory: string): Promise<{ readonly listing: DirectoryListing; readonly moved: boolean }> {
    const known = this.#listings.get(directory);
    const info = await stat(directory).catch(() => undefined);
    if (known?.trusted === true && info?.ino === known.ino && info.mtimeMs === known.mtimeMs)
      return { listing: known, moved: false };
    const entries =
      info?.isDirectory() === true ? await readdir(directory, { withFileTypes: true }).catch(() => []) : [];
    const listing: DirectoryListing = {
      ino: info?.ino ?? 0,
      mtimeMs: info?.mtimeMs ?? 0,
      trusted: info !== undefined && this.now() - info.mtimeMs >= SETTLED_MS,
      directories: entries.filter(entry => entry.isDirectory()).map(entry => entry.name),
      files: entries.filter(entry => entry.isFile() && entry.name.endsWith('.jsonl')).map(entry => entry.name),
    };
    if (info === undefined) this.#listings.delete(directory);
    else this.#listings.set(directory, listing);
    return { listing, moved: known === undefined ? entries.length > 0 : !sameEntries(known, listing) };
  }

  private changed(home: string): void {
    this.#changes.set(home, this.changes(home) + 1);
  }

  private async identify(file: string): Promise<RolloutIdentity> {
    const head = await this.window(file, 0, HEAD_BYTES);
    const id = metaFromHead(head ?? '').id;
    return id === undefined ? { id: idFromFilename(file), settled: false } : { id, settled: true };
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
    this.#opened += 1;
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
