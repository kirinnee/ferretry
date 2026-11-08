import { dirname } from 'node:path';
import type { FencedPath, RootHandle } from '@ferretry/kernel/contract';
import { type QueueAuthor, QueueAuthorSchema } from '../../../lib/protocol/session.ts';
import type { ResumeTurnStore } from '../../../lib/session/resume/types.ts';
import type { SessionId } from '../../../lib/session-id.ts';
import { assertOwnSession, assertSessionsRoot, OwnFolder } from '../sessions-root.ts';

/** Completion markers a previous turn may have left behind, as `{marker}.marker` in the ferret's own folder. */
export const TURN_MARKERS = ['done', 'needs-help', 'process-exit'] as const;

/** The directory a session's turn documents live in, beneath the session's own directory. */
const TURNS_DIRECTORY = 'turns';

/** `turn-001.md`, `turn-012.md`, `turn-1000.md`: a numbered turn document, at least three digits. */
const TURN_FILE = /^turn-(\d{3,})\.md$/u;

/** The most of one turn document (or its author record) a read takes: far above any brief a person or agent writes. */
const TURN_READ_LIMIT_BYTES = 4 * 1024 * 1024;

/** What this store asks of the kernel's root. */
export type TurnRoot = Pick<
  RootHandle,
  | 'name'
  | 'internal'
  | 'ensurePrivateDirectory'
  | 'resolve'
  | 'publish'
  | 'readDurable'
  | 'syncDirectory'
  | 'list'
  | 'readText'
  | 'lstat'
  | 'remove'
>;

/** One turn document as the store reads it back, and who it is from when Ferretry recorded that beside it. */
export interface StoredTurn {
  readonly turn: number;
  readonly text: string;
  readonly by?: QueueAuthor;
}

/** `turn-008.md` → `turn-008.by.json`. */
const authorName = (turnName: string): string => turnName.replace(/\.md$/u, '.by.json');

/**
 * Turn documents inside the ferret's own private folder on the internal `sessions` root
 * (`state/ferrets/sessions/<ferret>/turns/turn-NNN.md`, the author beside it as `turn-NNN.by.json`).
 *
 * The write is durable (the kernel's `publish`: synced temp file, rename, folder synced) and the turn is numbered, so
 * a revived agent reads its NEW assignment and a retried relaunch re-delivers exactly the same one. AN EXACT REPLAY IS
 * PROVED, NOT REWRITTEN: identical bytes are read and synced in place through one held descriptor, and the path is
 * proved to still name that file, so an agent mid-read of the document it was told to open never loses it to a new
 * inode. Markers are removed before the relaunch: a `done` file left by the previous turn would end the new turn the
 * moment it started.
 *
 * The handle is scoped to ONE ferret's folder, and the store refuses any call that names another ferret, so it can
 * write or read no other ferret's turns; it refuses at construction any root but the internal `sessions` one.
 */
export class FileResumeTurnStore implements ResumeTurnStore {
  private readonly folder: OwnFolder;

  constructor(
    private readonly root: TurnRoot,
    private readonly ferret: SessionId,
  ) {
    assertSessionsRoot(root, 'the resume turn store');
    this.folder = new OwnFolder(root);
  }

  /** The turn document for `turn` (`turns/turn-NNN.md`), as the absolute path an agent opens. */
  file(id: SessionId, turn: number): FencedPath {
    assertOwnSession(this.ferret, id, 'the resume turn store');
    if (!Number.isInteger(turn) || turn < 1) throw new Error(`a turn number is a whole number from one (got ${turn})`);
    return this.path(`${TURNS_DIRECTORY}/turn-${String(turn).padStart(3, '0')}.md`);
  }

  async writeTurn(id: SessionId, turn: number, document: string, by?: QueueAuthor): Promise<string> {
    const file = this.file(id, turn);
    await this.folder.ensure();
    // Who the turn is from sits BESIDE it, never in it: the agent reads the document, the app reads this. It lands
    // first, so a document is never on disk with an author that a crash then failed to record.
    if (by !== undefined)
      await this.durably(authorName(file) as FencedPath, `${JSON.stringify(QueueAuthorSchema.parse(by))}\n`);
    await this.durably(file, document);
    return file;
  }

  async clearMarkers(id: SessionId): Promise<void> {
    assertOwnSession(this.ferret, id, 'the resume turn store');
    await this.folder.ensure();
    for (const marker of TURN_MARKERS) {
      const file = this.path(`${marker}.marker`);
      // The leaf is never followed: a link at a marker's name is the link removed, not what it points at.
      if ((await this.root.lstat(file)) !== undefined) await this.root.remove(file);
    }
  }

  /**
   * Every turn document, oldest first, with its author when one is recorded. STRICT rejects anything it cannot read (a
   * document that vanished mid-read, an author record that does not parse), so "nobody spoke" is never mistaken for
   * "nothing could be read"; best effort skips what it cannot read, and an unreadable author names nobody.
   */
  async list(id: SessionId, options: { readonly strict: boolean }): Promise<readonly StoredTurn[]> {
    assertOwnSession(this.ferret, id, 'the resume turn store');
    await this.folder.ensure();
    const directory = this.path(TURNS_DIRECTORY);
    if ((await this.root.lstat(directory)) === undefined) return [];
    const names = new Set(await this.root.list(directory));
    const turns: StoredTurn[] = [];
    for (const name of names) {
      const number = TURN_FILE.exec(name)?.[1];
      if (number === undefined) continue;
      let text: string;
      try {
        text = await this.root.readText(this.path(`${TURNS_DIRECTORY}/${name}`), TURN_READ_LIMIT_BYTES);
      } catch (error) {
        if (options.strict) throw new Error(`turn document ${name} could not be read`, { cause: error });
        continue;
      }
      const by = names.has(authorName(name)) ? await this.author(authorName(name), options.strict) : undefined;
      turns.push({ turn: Number(number), text, ...(by === undefined ? {} : { by }) });
    }
    return turns.sort((a, b) => a.turn - b.turn);
  }

  /** The highest turn a document is on disk for, or 0 when there is none (best effort). */
  async latest(id: SessionId): Promise<number> {
    const turns = await this.list(id, { strict: false });
    return turns.at(-1)?.turn ?? 0;
  }

  /** Who a turn document is from, by the record Ferretry wrote beside it. Named by file only, never quoted. */
  private async author(name: string, strict: boolean): Promise<QueueAuthor | undefined> {
    try {
      const raw = await this.root.readText(this.path(`${TURNS_DIRECTORY}/${name}`), TURN_READ_LIMIT_BYTES);
      const parsed = QueueAuthorSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
      if (strict) throw new Error(`turn author record ${name} does not parse`);
      return undefined;
    } catch (error) {
      if (strict) throw error instanceof Error ? error : new Error(`turn author record ${name} could not be read`);
      return undefined;
    }
  }

  private path(relative: string): FencedPath {
    const resolved = this.root.resolve(relative);
    if (!resolved.ok) throw new Error(`the ferret's turn file is outside its root (${resolved.error})`);
    return resolved.value;
  }

  /**
   * Identical bytes are proved durable in place (one held descriptor read and synced, the folder synced parent first,
   * then the path proved to still name that file); anything else is published over the name.
   */
  private async durably(file: FencedPath, contents: string): Promise<void> {
    const replayed = await this.root.readDurable(file, TURN_READ_LIMIT_BYTES, async held => {
      if (new TextDecoder().decode(held.bytes) !== contents) return false;
      await this.root.syncDirectory(dirname(file) as FencedPath, { parent: true });
      if (!(await held.stillNames()))
        throw new Error(`${file} stopped naming the turn document this write proved, so nothing was overwritten`);
      return true;
    });
    if (replayed === true) return;
    await this.root.publish(file, new TextEncoder().encode(contents), { mode: 0o600 });
  }
}
