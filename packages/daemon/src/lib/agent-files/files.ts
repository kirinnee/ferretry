import { basename, dirname, join, resolve } from 'node:path';
import { type FileIdentity, openedFileProblem, resolveStateHomes } from '@ferretry/fleet';
import type { AgentUploadFile } from '@ferretry/protocol';
import {
  AGENT_FILE_LIMITS,
  AgentFileError,
  DEFAULT_SAVE_FOLDER,
  isWithin,
  lexicalTarget,
  realTarget,
  relativeWords,
  STAGED_FILE_TTL_MS,
  sanitizeFileName,
  stateHomeRefusal,
  uploadSizeProblem,
} from './policy.ts';

/** Which file an entry is (the shared state-home guard's {@link FileIdentity}). */
export type AgentFileIdentity = FileIdentity;

/** A file opened to read: its identity as the open descriptor sees it, and a copy out of that descriptor. */
export interface AgentOpenFile {
  readonly identity: AgentFileIdentity;
  /** Copies what the descriptor reads into a NEW private file (never into a link); refuses to grow past `maxBytes`. */
  copyTo(to: string, maxBytes: number): Promise<number>;
  close(): Promise<void>;
}

/** What the file tools ask of the disk. Structural, so a unit test supplies a fake and the daemon a Node one. */
export interface AgentFilesystem {
  realpath(path: string): Promise<string>;
  /** The entry itself (a symlink is reported as `link`, never followed), or `undefined` when nothing is there. */
  lstat(
    path: string,
  ): Promise<{ readonly kind: 'file' | 'directory' | 'link' | 'other'; readonly size: number } | undefined>;
  /** The entry itself, never followed, with its device and inode; `undefined` when nothing is there. */
  identity(path: string): Promise<AgentFileIdentity | undefined>;
  /** Opens `path` to read without following a link at its last step and without blocking on a pipe. */
  openRead(path: string): Promise<AgentOpenFile>;
  /** The names in a folder; none when there is no such folder. */
  list(path: string): Promise<readonly string[]>;
  mkdirp(path: string, mode: number): Promise<void>;
  writeNew(path: string, bytes: Uint8Array, mode: number): Promise<void>;
  /** Copies into a NEW file (never into a link, never executable); refuses to grow past `maxBytes`. */
  copyNew(from: string, to: string, maxBytes: number): Promise<number>;
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
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
/** A placed copy's directory: when it was placed, then a token. */
const PLACED_NAME = /^(\d+)-/u;

interface Root {
  readonly folder: string;
  readonly real: string;
  /** The daemon's own directories, each as configured and as resolved. */
  readonly homes: readonly string[];
}

/**
 * What the file tools may reach: the session's own folder and nothing else — and never the daemon's own
 * state home, even when the folder holds it.
 *
 * Reading (an upload) takes a path or an attachment id; writing (a download or a PDF) takes a place under
 * the folder. Both resolve REAL paths — a symlink in the folder that leads out of it is refused, not
 * followed. A file an agent names is OPENED, checked to be the file that was resolved, and copied into the
 * daemon's own directory; the browser is handed the copy, so a path swapped after the check reaches nothing.
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
    let homes: readonly string[];
    try {
      homes = await resolveStateHomes(this.ports.stateHomes, this.ports.fs);
    } catch {
      // Unresolved, a symlinked home could not be recognised by its real path: refuse rather than guess.
      throw new AgentFileError('unavailable', 'this daemon’s state home cannot be resolved, so no file is reached');
    }
    return { folder: resolve(folder), real, homes };
  }

  /** The folder rule and the state-home rule, on a real path. */
  private confined(root: Root, realPath: string, verb: 'read' | 'write'): string {
    realTarget(root.real, realPath);
    const refusal = stateHomeRefusal(root.homes, realPath, verb);
    if (refusal !== undefined) throw refusal;
    return realPath;
  }

  async prepareUpload(sessionId: string, sources: readonly AgentUploadFile[]): Promise<PreparedUpload> {
    const root = await this.root(sessionId);
    await this.prune();
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
   * its call because a page may read the file it was given later — when its form is submitted.
   */
  private async prune(): Promise<void> {
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
    const named = stateHomeRefusal(root.homes, candidate, 'read');
    if (named !== undefined) throw named;
    let real: string;
    try {
      real = await this.ports.fs.realpath(candidate);
    } catch {
      throw new AgentFileError('not_found', `no file at ${shown}`);
    }
    this.confined(root, real, 'read');
    let file: AgentOpenFile;
    try {
      file = await this.ports.fs.openRead(real);
    } catch {
      throw new AgentFileError('not_found', `${shown} cannot be opened to read`);
    }
    try {
      // What was opened must be a regular file still at the checked place, with no other name: a hard link's
      // other name may be anywhere on the disk, the state home included, and nothing on the file says where.
      const problem = await openedFileProblem(real, file.identity, this.ports.fs);
      if (problem === 'not-a-file') throw new AgentFileError('bad_request', `${shown} is not a file`);
      if (problem === 'changed')
        throw new AgentFileError(
          'forbidden',
          `${shown} changed while it was being checked, so it is refused`,
          'changed',
        );
      if (problem === 'hard-link')
        throw new AgentFileError(
          'forbidden',
          `${shown} is a hard link (the file has ${String(file.identity.links)} names), and another of its names could be inside the daemon's state home, so it is refused: copy it and upload the copy`,
          'hard-link',
        );
      if (file.identity.size > AGENT_FILE_LIMITS.fileBytes)
        throw new AgentFileError('bad_request', `${shown} is over the upload size limit`);
      const name = sanitizeFileName(real, 'file');
      const copy = join(await this.place(placed), name);
      const size = await file.copyTo(copy, AGENT_FILE_LIMITS.fileBytes);
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
   * an existing file unless `overwrite`, never follows a link out of the folder, never makes the file executable.
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
    const destination = await this.destination(root, requested, options.overwrite === true);
    await this.ports.fs.mkdirp(dirname(destination), DIRECTORY_MODE);
    // The folder just made is checked again: a link planted between the check and the mkdir would show here.
    this.confined(root, await this.ports.fs.realpath(dirname(destination)), 'write');
    if (options.overwrite === true) await this.ports.fs.remove(destination).catch(() => undefined);
    let size: number;
    try {
      size = await this.ports.fs.copyNew(staged.path, destination, options.maxBytes);
    } catch (error) {
      await this.ports.fs.remove(destination).catch(() => undefined);
      if (error instanceof AgentFileError) throw error;
      throw new AgentFileError('conflict', 'that place cannot be written');
    }
    const shown = isWithin(root.real, destination)
      ? relativeWords(root.real, destination)
      : relativeWords(root.folder, destination);
    return { saved: shown, name: sanitizeFileName(destination, 'file'), size };
  }

  private async destination(root: Root, requested: string, overwrite: boolean): Promise<string> {
    const lexical = lexicalTarget(root.folder, requested);
    if (lexical === root.folder) throw new AgentFileError('bad_request', 'name a file, not the folder itself');
    const named = stateHomeRefusal(root.homes, lexical, 'write');
    if (named !== undefined) throw named;
    // The nearest ancestor that exists decides where the path REALLY goes; what is below it is new.
    let ancestor = lexical;
    const missing: string[] = [];
    for (;;) {
      const entry = await this.ports.fs.lstat(ancestor);
      if (entry !== undefined) break;
      missing.unshift(ancestor.slice(dirname(ancestor).length + 1));
      ancestor = dirname(ancestor);
    }
    const entry = await this.ports.fs.lstat(ancestor);
    if (missing.length === 0) {
      if (entry?.kind === 'directory')
        throw new AgentFileError('conflict', `${relativeWords(root.folder, lexical)} is a folder`);
      if (entry?.kind === 'link') throw new AgentFileError('forbidden', 'a link is never written through');
      if (!overwrite)
        throw new AgentFileError(
          'conflict',
          `${relativeWords(root.folder, lexical)} already exists — pass overwrite to replace it`,
        );
      this.confined(root, join(await this.ports.fs.realpath(dirname(lexical)), basename(lexical)), 'write');
      return lexical;
    }
    const realAncestor = await this.ports.fs.realpath(ancestor).catch(() => {
      throw new AgentFileError('forbidden', 'that place cannot be resolved');
    });
    return this.confined(root, join(realAncestor, ...missing), 'write');
  }
}
