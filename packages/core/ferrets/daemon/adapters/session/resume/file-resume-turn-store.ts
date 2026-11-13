import { dirname } from 'node:path';
import type { FencedPath, RootHandle } from '@ferretry/kernel/contract';
import { FERRET_TURNS_FOLDER, ferretTurnFile } from '../../../../contract/sessions-root.ts';
import { type QueueAuthor, QueueAuthorSchema } from '../../../lib/protocol/session.ts';
import type { ResumeTurnStore } from '../../../lib/session/resume/types.ts';
import type { SessionId } from '../../../lib/session-id.ts';
import { assertOwnSession, assertSessionsRoot, OwnFolder } from '../sessions-root.ts';

/** Completion markers a previous turn may have left behind, as `{marker}.marker` in the ferret's own folder. */
export const TURN_MARKERS = ['done', 'needs-help', 'process-exit'] as const;

/** The directory a session's turn documents live in, beneath the session's own directory (the contract's fact). */
const TURNS_DIRECTORY = FERRET_TURNS_FOLDER;

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
  | 'entries'
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

/** The bytes of an author record, exactly as {@link FileResumeTurnStore.writeTurn} writes them. */
const authorRecord = (by: QueueAuthor): string => `${JSON.stringify(QueueAuthorSchema.parse(by))}\n`;

/**
 * A turn file whose NAME is not the regular file that was read: a link (to the ferret's own `environment.json`, say),
 * or a name swapped while it was read. Says which kind of file only, never a path or a byte of it.
 */
class TurnFileNotOwn extends Error {
  constructor() {
    super('a turn file is not a regular file of its own, so it was not read');
    this.name = 'TurnFileNotOwn';
  }
}

/** The kernel's refusal word, read structurally: this plugin may not import the kernel's host. */
function refusalOf(error: unknown): string | undefined {
  if (!(error instanceof Error) || error.name !== 'RootError') return undefined;
  const refusal = (error as { readonly refusal?: unknown }).refusal;
  return typeof refusal === 'string' ? refusal : undefined;
}

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
    return this.path(ferretTurnFile(turn));
  }

  async writeTurn(id: SessionId, turn: number, document: string, by?: QueueAuthor): Promise<string> {
    const file = this.file(id, turn);
    await this.folder.ensure();
    const author = authorName(file) as FencedPath;
    // Who the turn is from sits BESIDE it, never in it: the agent reads the document, the app reads this. It lands
    // first, so a document is never on disk with an author that a crash then failed to record. A turn with no author
    // first removes any record already at its number (one a crash left before its document landed): an author is
    // never left beside words it did not write. The leaf is never followed, as for the markers.
    if (by !== undefined) await this.durably(author, authorRecord(by));
    else if ((await this.root.lstat(author)) !== undefined) await this.root.remove(author);
    await this.durably(file, document);
    return file;
  }

  /**
   * Whether `turn`'s document on disk is EXACTLY `document` from exactly `by` (no author record when `by` is absent):
   * the one case a revive may hand the same number over again, proved in place by {@link writeTurn}. Anything it
   * cannot read is not a match, so a revive numbers past it and never writes over it.
   */
  async matches(id: SessionId, turn: number, document: string, by?: QueueAuthor): Promise<boolean> {
    const file = this.file(id, turn);
    if (!(await this.present())) return false;
    const author = authorName(file) as FencedPath;
    try {
      if ((await this.readOwn(file)) !== document) return false;
      if (by === undefined) return (await this.root.lstat(author)) === undefined;
      return (await this.readOwn(author)) === authorRecord(by);
    } catch {
      return false;
    }
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
    // A READ never makes the folder: a ferret with none has no turns, and making it here would race a launch's own
    // `prepare` of the same folder (the loser is refused as `changed`).
    if (!(await this.present())) return [];
    const directory = this.path(TURNS_DIRECTORY);
    if ((await this.root.lstat(directory)) === undefined) return [];
    // Only a regular file is a turn: a link (to the ferret's own `environment.json`, say) or anything else at a turn's
    // name is skipped, never followed. The read below proves it again while it holds the file, so a name swapped for a
    // link between this listing and that read is refused too.
    const names = new Set(
      (await this.root.entries(directory)).filter(entry => entry.kind === 'file').map(entry => entry.name),
    );
    const turns: StoredTurn[] = [];
    for (const name of names) {
      const number = TURN_FILE.exec(name)?.[1];
      if (number === undefined) continue;
      let text: string;
      try {
        text = await this.readOwn(this.path(`${TURNS_DIRECTORY}/${name}`));
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
      const raw = await this.readOwn(this.path(`${TURNS_DIRECTORY}/${name}`));
      const parsed = QueueAuthorSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
      if (strict) throw new Error(`turn author record ${name} does not parse`);
      return undefined;
    } catch (error) {
      if (strict) throw error instanceof Error ? error : new Error(`turn author record ${name} could not be read`);
      return undefined;
    }
  }

  /**
   * Whether the ferret's own folder is there yet, asked without making it. The kernel answers every call through a
   * scoped handle whose folder does not exist with `outside` (read structurally: this plugin may not import the
   * kernel's host), so that refusal to look at a name directly inside it means "not made yet"; every other refusal,
   * and anything that is not a folder there, is raised by the read that follows, never softened into "no turns".
   */
  private async present(): Promise<boolean> {
    try {
      await this.root.lstat(this.path(TURNS_DIRECTORY));
      return true;
    } catch (error) {
      if (refusalOf(error) === 'outside') return false;
      throw error;
    }
  }

  /**
   * A turn file's text, read through ONE held descriptor and kept only when the NAME, its leaf never followed, still
   * reaches the very file that was read (the kernel's `readDurable` + `stillNames`). A link at the name reaches the
   * link, not its target, so it is refused ({@link TurnFileNotOwn}) whenever it was put there, before the open or
   * during the read: no window between a check and the read lets another file's bytes through. A file with a second
   * hard link is the kernel's own refusal. Gone is an error too.
   */
  private async readOwn(file: FencedPath): Promise<string> {
    const text = await this.root.readDurable(file, TURN_READ_LIMIT_BYTES, async held => {
      if (!(await held.stillNames())) throw new TurnFileNotOwn();
      return new TextDecoder().decode(held.bytes);
    });
    if (text === undefined) throw new Error('a turn file is gone');
    return text;
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
