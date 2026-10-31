import { dirname, join, relative, resolve } from 'node:path';
import type { AgentUploadFile } from '@ferretry/protocol';
import {
  AGENT_FILE_LIMITS,
  AgentFileError,
  DEFAULT_SAVE_FOLDER,
  forbiddenInside,
  isWithin,
  lexicalTarget,
  realTarget,
  relativeWords,
  sanitizeFileName,
  uploadSizeProblem,
} from './policy.ts';

/** What the file tools ask of the disk. Structural, so a unit test supplies a fake and the daemon a Node one. */
export interface AgentFilesystem {
  realpath(path: string): Promise<string>;
  /** The entry itself (a symlink is reported as `link`, never followed), or `undefined` when nothing is there. */
  lstat(
    path: string,
  ): Promise<{ readonly kind: 'file' | 'directory' | 'link' | 'other'; readonly size: number } | undefined>;
  /** The size of the regular file at `path`, following links; `undefined` when it is not one. */
  fileSize(path: string): Promise<number | undefined>;
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
  /** The daemon-owned directory attachments are placed in for the browser to read. */
  readonly uploadDirectory: string;
  /** A fresh unguessable token, for a directory name. */
  token(): string;
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

/**
 * What the file tools may reach: the session's own folder and nothing else.
 *
 * Reading (an upload) takes a path or an attachment id; writing (a download or a PDF) takes a place under
 * the folder. Both resolve REAL paths — a symlink in the folder that leads out of it is refused, not
 * followed. The check and the later read are two steps, so a file swapped for a link in between is
 * a declared gap (docs/agent-tools.md#files), not a closed one.
 */
export class AgentFiles {
  constructor(private readonly ports: AgentFilesPorts) {}

  private async root(sessionId: string): Promise<{ readonly folder: string; readonly real: string }> {
    const folder = await this.ports.folderOf(sessionId);
    if (folder === undefined) throw new AgentFileError('not_found', 'this session has no working folder');
    try {
      return { folder: resolve(folder), real: await this.ports.fs.realpath(resolve(folder)) };
    } catch {
      throw new AgentFileError('unavailable', 'this session’s working folder is not available');
    }
  }

  async prepareUpload(sessionId: string, sources: readonly AgentUploadFile[]): Promise<PreparedUpload> {
    const root = await this.root(sessionId);
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
            ? await this.existing(root, source)
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

  private async existing(
    root: { readonly folder: string; readonly real: string },
    requested: string,
  ): Promise<PreparedUploadFile> {
    const candidate = lexicalTarget(root.folder, requested);
    let real: string;
    try {
      real = await this.ports.fs.realpath(candidate);
    } catch {
      throw new AgentFileError('not_found', `no file at ${relativeWords(root.folder, candidate)}`);
    }
    realTarget(root.real, real);
    const size = await this.ports.fs.fileSize(real);
    if (size === undefined)
      throw new AgentFileError('bad_request', `${relativeWords(root.folder, candidate)} is not a file`);
    if (size > AGENT_FILE_LIMITS.fileBytes)
      throw new AgentFileError('bad_request', `${relativeWords(root.folder, candidate)} is over the upload size limit`);
    return { path: real, name: sanitizeFileName(real, 'file'), size };
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
    const directory = join(this.ports.uploadDirectory, this.ports.token());
    placed.push(directory);
    const name = sanitizeFileName(attachment.filename, 'attachment');
    await this.ports.fs.mkdirp(directory, PRIVATE_DIRECTORY_MODE);
    await this.ports.fs.writeNew(join(directory, name), attachment.bytes, PRIVATE_FILE_MODE);
    return { path: join(directory, name), name, size: attachment.bytes.byteLength };
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
    realTarget(root.real, await this.ports.fs.realpath(dirname(destination)));
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

  private async destination(
    root: { readonly folder: string; readonly real: string },
    requested: string,
    overwrite: boolean,
  ): Promise<string> {
    const lexical = lexicalTarget(root.folder, requested);
    if (lexical === root.folder) throw new AgentFileError('bad_request', 'name a file, not the folder itself');
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
      realTarget(root.real, await this.ports.fs.realpath(dirname(lexical)));
      return lexical;
    }
    const realAncestor = await this.ports.fs.realpath(ancestor).catch(() => {
      throw new AgentFileError('forbidden', 'that place cannot be resolved');
    });
    realTarget(root.real, realAncestor);
    const real = join(realAncestor, ...missing);
    const refusal = forbiddenInside(relative(root.real, real));
    if (refusal !== undefined) throw new AgentFileError('forbidden', refusal);
    return real;
  }
}
