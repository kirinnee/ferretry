import { basename, dirname, join, resolve } from 'node:path';
import {
  createOutsideStateHomes,
  type FileIdentity,
  type GuardDisk,
  type Guarded,
  openOutsideStateHomes,
  resolveStateHomes,
  type StateHomes,
  stateHomeByName,
} from '@ferretry/fleet';
import type { AgentUploadFile } from '@ferretry/protocol';
import {
  AGENT_FILE_LIMITS,
  AgentFileError,
  DEFAULT_SAVE_FOLDER,
  lexicalTarget,
  realTarget,
  relativeWords,
  STAGED_FILE_TTL_MS,
  sanitizeFileName,
  uploadSizeProblem,
} from './policy.ts';

/** Which file an entry is (the shared state-home guard's {@link FileIdentity}). */
export type AgentFileIdentity = FileIdentity;

/**
 * What the file tools ask of the disk: the state-home guard's disk (`@ferretry/fleet`), plus making folders,
 * placing the daemon's own copies and removing them. Structural, so a unit test supplies a fake.
 */
export interface AgentFilesystem extends GuardDisk {
  mkdirp(path: string, mode: number): Promise<void>;
  writeNew(path: string, bytes: Uint8Array, mode: number): Promise<void>;
  /** Removes a DAEMON-OWNED entry (its own copies); never used on a path an agent named. */
  remove(path: string, options?: { readonly recursive?: boolean }): Promise<void>;
}

export interface AgentFilesPorts {
  readonly fs: AgentFilesystem;
  /** The folder a session works in; `undefined` when the session is unknown. */
  folderOf(sessionId: string): Promise<string | undefined>;
  /** This session's own attachment, by id; throws when it has none such. */
  readAttachment(
    sessionId: string,
    attachmentId: string,
  ): Promise<{ readonly filename: string; readonly bytes: Uint8Array }>;
  /** The daemon-owned directory every file handed to the browser is copied into. */
  readonly uploadDirectory: string;
  /**
   * The daemon's own directories, as it resolved them: its state home first, then its state and config
   * directories. No file tool reads or writes inside one, however a path reaches it.
   */
  readonly stateHomes: readonly string[];
  /** A fresh unguessable token, for a directory name. */
  token(): string;
  /** Now, in epoch milliseconds: when a copy was placed, and so when it is removed. */
  now(): number;
}

/** One file the browser may be handed: where it is, what to call it and how big it is. */
export interface PreparedUploadFile {
  readonly path: string;
  readonly name: string;
  readonly size: number;
}

export interface PreparedUpload {
  readonly files: readonly PreparedUploadFile[];
  /** Removes whatever this preparation placed for the browser. Safe to call more than once. */
  release(): Promise<void>;
}

/** A file the browser staged in the daemon's own directory, waiting to be saved. */
export interface StagedFile {
  readonly path: string;
  readonly name: string;
  readonly size: number;
}

export interface SavedFile {
  /** Relative to the session's folder, forward slashes. */
  readonly saved: string;
  readonly name: string;
  readonly size: number;
}

const DIRECTORY_MODE = 0o755;
const SAVED_FILE_MODE = 0o644;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
/** A placed copy's directory: when it was placed, then a token. */
const PLACED_NAME = /^(\d+)-/u;

interface Root {
  readonly folder: string;
  readonly real: string;
  readonly homes: StateHomes;
}

/** The state-home refusal, in the file tools' words. */
function stateHomeError(home: string, verb: 'read' | 'write'): AgentFileError {
  return new AgentFileError(
    'forbidden',
    `that path is inside this daemon's state home (${home}), which holds this machine's credentials, so the file tools never ${verb} there`,
    'state-home',
  );
}

/** A guard's refusal, in the file tools' words. */
function refusalOf(
  refusal: Extract<Guarded<unknown>, { readonly ok: false }>,
  shown: string,
  verb: 'read' | 'write',
): AgentFileError {
  switch (refusal.rule) {
    case 'state-home':
      return stateHomeError(refusal.home ?? 'the state home', verb);
    case 'outside':
      return new AgentFileError('forbidden', 'that path leads outside this session’s folder, so it is refused');
    case 'not-found':
      return new AgentFileError('not_found', verb === 'read' ? `no file at ${shown}` : 'that place cannot be resolved');
    case 'not-a-file':
      return new AgentFileError('bad_request', `${shown} is not a file`);
    case 'hard-link':
      return new AgentFileError(
        'forbidden',
        `${shown} is a hard link (the file has more than one name), and another of its names could be inside the daemon's state home, so it is refused: ${verb === 'read' ? 'copy it and upload the copy' : 'remove it or save elsewhere'}`,
        'hard-link',
      );
    case 'taken':
      return new AgentFileError('conflict', `${shown} already exists — pass overwrite to replace it`);
    default:
      return new AgentFileError(
        'forbidden',
        `${shown} changed while it was being checked, so it is refused`,
        'changed',
      );
  }
}

/**
 * What the file tools may reach: the session's own folder and nothing else — and never the daemon's own
 * state home, even when the folder holds it. Every read and write goes through the shared state-home guard
 * (`state-home-guard.ts` in `@ferretry/fleet`), which judges a path by name, by real path and by identity and
 * proves the file it opened is the one it checked.
 *
 * Reading (an upload) takes a path or an attachment id, and the browser is handed the DAEMON'S copy of it, so a
 * path swapped after the check reaches nothing. Writing (a download or a PDF) goes through a descriptor opened
 * in a checked folder, and nothing is ever removed by a path an agent could have swapped.
 */
export class AgentFiles {
  constructor(private readonly ports: AgentFilesPorts) {}

  private async root(sessionId: string): Promise<Root> {
    const folder = await this.ports.folderOf(sessionId);
    if (folder === undefined) throw new AgentFileError('not_found', 'this session has no working folder');
    let real: string;
    try {
      real = await this.ports.fs.realpath(resolve(folder));
    } catch {
      throw new AgentFileError('unavailable', 'this session’s working folder is not available');
    }
    let homes: StateHomes;
    try {
      homes = await resolveStateHomes({ homes: this.ports.stateHomes }, this.ports.fs);
    } catch {
      // Unresolved, a symlinked home could not be recognised by its real path: refuse rather than guess.
      throw new AgentFileError('unavailable', 'this daemon’s state home cannot be resolved, so no file is reached');
    }
    return { folder: resolve(folder), real, homes };
  }

  /** The folder rule and the state-home rule (by name), on a real path. */
  private confined(root: Root, realPath: string, verb: 'read' | 'write'): string {
    realTarget(root.real, realPath);
    const verdict = stateHomeByName(root.homes, realPath);
    if (verdict.inside) throw stateHomeError(verdict.home, verb);
    return realPath;
  }

  async prepareUpload(sessionId: string, sources: readonly AgentUploadFile[]): Promise<PreparedUpload> {
    const root = await this.root(sessionId);
    await this.sweep();
    const files: PreparedUploadFile[] = [];
    const placed: string[] = [];
    const release = async (): Promise<void> => {
      for (const directory of placed.splice(0))
        await this.ports.fs.remove(directory, { recursive: true }).catch(() => undefined);
    };
    try {
      for (const source of sources) {
        files.push(
          typeof source === 'string'
            ? await this.existing(root, source, placed)
            : await this.attached(sessionId, source.attachment, placed),
        );
        const problem = uploadSizeProblem(files.map(file => file.size));
        if (problem !== undefined) throw new AgentFileError('bad_request', problem);
      }
    } catch (error) {
      await release();
      throw error;
    }
    return { files, release };
  }

  /**
   * Removes the copies placed for earlier uploads once {@link STAGED_FILE_TTL_MS} has passed. A copy outlives
   * its call because a page may read the file it was given later — when its form is submitted. Run before
   * every upload, and by the daemon at boot and on a timer, so a copy never outlives its time by much.
   */
  async sweep(): Promise<void> {
    const cutoff = this.ports.now() - STAGED_FILE_TTL_MS;
    const names = await this.ports.fs.list(this.ports.uploadDirectory).catch(() => []);
    for (const name of names) {
      const placedAt = PLACED_NAME.exec(name)?.[1];
      if (placedAt !== undefined && Number(placedAt) > cutoff) continue;
      await this.ports.fs.remove(join(this.ports.uploadDirectory, name), { recursive: true }).catch(() => undefined);
    }
  }

  /** A fresh private directory for one copy, recorded so a refusal removes it. */
  private async place(placed: string[]): Promise<string> {
    const directory = join(this.ports.uploadDirectory, `${String(this.ports.now())}-${this.ports.token()}`);
    placed.push(directory);
    await this.ports.fs.mkdirp(directory, PRIVATE_DIRECTORY_MODE);
    return directory;
  }

  private async existing(root: Root, requested: string, placed: string[]): Promise<PreparedUploadFile> {
    const candidate = lexicalTarget(root.folder, requested);
    const shown = relativeWords(root.folder, candidate);
    const opened = await openOutsideStateHomes(candidate, root.homes, this.ports.fs, { inside: root.real });
    if (!opened.ok) throw refusalOf(opened, shown, 'read');
    const file = opened.value;
    try {
      this.confined(root, file.path, 'read');
      if (file.identity.size > AGENT_FILE_LIMITS.fileBytes)
        throw new AgentFileError('bad_request', `${shown} is over the upload size limit`);
      const name = sanitizeFileName(file.path, 'file');
      const copy = join(await this.place(placed), name);
      const size = await file.copyTo(copy, AGENT_FILE_LIMITS.fileBytes, PRIVATE_FILE_MODE).catch(() => {
        throw new AgentFileError(
          'bad_request',
          `${shown} could not be read whole: it grew past the upload size limit, or the read failed`,
        );
      });
      return { path: copy, name, size };
    } finally {
      await file.close();
    }
  }

  private async attached(sessionId: string, attachmentId: string, placed: string[]): Promise<PreparedUploadFile> {
    let attachment: { readonly filename: string; readonly bytes: Uint8Array };
    try {
      attachment = await this.ports.readAttachment(sessionId, attachmentId);
    } catch {
      throw new AgentFileError('not_found', 'this session has no attachment with that id');
    }
    if (attachment.bytes.byteLength > AGENT_FILE_LIMITS.fileBytes)
      throw new AgentFileError('bad_request', 'that attachment is over the upload size limit');
    const name = sanitizeFileName(attachment.filename, 'attachment');
    const path = join(await this.place(placed), name);
    await this.ports.fs.writeNew(path, attachment.bytes, PRIVATE_FILE_MODE);
    return { path, name, size: attachment.bytes.byteLength };
  }

  /**
   * Saves a staged file into the session's folder: `saveAs` (relative) or `downloads/<name>`. Never replaces
   * an existing file unless `overwrite`, never writes through a link or into the state home, never makes the
   * file executable, and never removes a file by path.
   */
  async save(
    sessionId: string,
    staged: StagedFile,
    options: {
      readonly saveAs?: string | undefined;
      readonly overwrite?: boolean | undefined;
      readonly maxBytes: number;
    },
  ): Promise<SavedFile> {
    const root = await this.root(sessionId);
    if (staged.size > options.maxBytes)
      throw new AgentFileError('bad_request', 'that file is over the save size limit');
    const requested = options.saveAs ?? `${DEFAULT_SAVE_FOLDER}/${sanitizeFileName(staged.name, 'download')}`;
    const overwrite = options.overwrite === true;
    const destination = await this.destination(root, requested, overwrite);
    const shown = relativeWords(root.folder, lexicalTarget(root.folder, requested));
    await this.ports.fs.mkdirp(dirname(destination), DIRECTORY_MODE);
    // The folder is opened and checked, and the file reached THROUGH it and proven before a byte is written.
    const opened = await createOutsideStateHomes(destination, root.homes, this.ports.fs, {
      inside: root.real,
      overwrite,
      mode: SAVED_FILE_MODE,
    });
    if (!opened.ok) throw refusalOf(opened, shown, 'write');
    const file = opened.value;
    let size: number;
    try {
      // `.git` and the daemon's scratch entries, where the folder REALLY is now.
      this.confined(root, file.path, 'write');
      size = await file.copyFrom(staged.path, options.maxBytes);
    } catch (error) {
      await file.discard().catch(() => undefined);
      await file.close();
      if (error instanceof AgentFileError) throw error;
      throw new AgentFileError(
        'bad_request',
        'that file could not be saved whole: it grew past the save size limit, or the write failed',
      );
    }
    await file.close();
    // The guard kept it under the folder's real path, so that is where it is named from.
    return { saved: relativeWords(root.real, file.path), name: sanitizeFileName(file.path, 'file'), size };
  }

  private async destination(root: Root, requested: string, overwrite: boolean): Promise<string> {
    const lexical = lexicalTarget(root.folder, requested);
    if (lexical === root.folder) throw new AgentFileError('bad_request', 'name a file, not the folder itself');
    const named = stateHomeByName(root.homes, lexical);
    if (named.inside) throw stateHomeError(named.home, 'write');
    // The nearest ancestor that exists decides where the path REALLY goes; what is below it is new.
    let ancestor = lexical;
    const missing: string[] = [];
    for (;;) {
      const entry = await this.ports.fs.identity(ancestor);
      if (entry !== undefined) break;
      missing.unshift(ancestor.slice(dirname(ancestor).length + 1));
      ancestor = dirname(ancestor);
    }
    const entry = await this.ports.fs.identity(ancestor);
    if (missing.length === 0) {
      if (entry?.kind === 'directory')
        throw new AgentFileError('conflict', `${relativeWords(root.folder, lexical)} is a folder`);
      if (entry?.kind === 'link') throw new AgentFileError('forbidden', 'a link is never written through');
      if (!overwrite)
        throw new AgentFileError(
          'conflict',
          `${relativeWords(root.folder, lexical)} already exists — pass overwrite to replace it`,
        );
      return this.confined(root, join(await this.ports.fs.realpath(dirname(lexical)), basename(lexical)), 'write');
    }
    const realAncestor = await this.ports.fs.realpath(ancestor).catch(() => {
      throw new AgentFileError('forbidden', 'that place cannot be resolved');
    });
    return this.confined(root, join(realAncestor, ...missing), 'write');
  }
}
