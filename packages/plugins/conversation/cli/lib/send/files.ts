import { CommandError } from '../errors.ts';
import { NO_FILE_ACCESS } from '../gateway.ts';
import type { AttachmentSource, SendFiles, StagedAttachment } from './ports.ts';

/** What the shell's context offers for reading a local path (`CliContext.readText` / `readBytes`); each may be absent. */
export interface ShellFileReads {
  readText?(path: string): Promise<string>;
  readBytes?(path: string): Promise<Uint8Array>;
}

/**
 * The type a file is sent under, from its extension. An image or a PDF is named by its type (a PDF's type is how the daemon
 * knows to look for a password); anything else is `application/octet-stream`, and the daemon decides what a document is.
 */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  heic: 'image/heic',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export const mimeOfPath = (path: string): string => {
  const dot = path.lastIndexOf('.');
  const extension = dot === -1 ? '' : path.slice(dot + 1).toLowerCase();
  return MIME_BY_EXTENSION[extension] ?? 'application/octet-stream';
};

/** The last path segment, either separator: the name an attachment is shown under. */
const baseName = (path: string): string =>
  path
    .split(/[\\/]/u)
    .filter(part => part !== '')
    .pop() ?? path;

/** Base64 of bytes, in slices so a large file never spreads into one call's arguments. */
const base64Of = (bytes: Uint8Array): string => {
  let binary = '';
  for (let offset = 0; offset < bytes.byteLength; offset += 32_768)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  return btoa(binary);
};

const why = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The reads `fy send --message-file` and `-f` make, over the shell's own readers. As v4's `SessionFiles`: a path that cannot
 * be read (missing, a directory, no permission) is the caller's own mistake naming the path they typed (exit 2), never the
 * runtime's stack; an empty attachment is refused. How large a file may be is the daemon's to say, not the reader's: the
 * upload route bounds it and its sentence reaches the caller.
 */
export const shellFiles = (shell: ShellFileReads): SendFiles & AttachmentSource => ({
  readText: async path => {
    if (shell.readText === undefined) throw new CommandError(NO_FILE_ACCESS);
    try {
      return await shell.readText(path);
    } catch (error) {
      throw new CommandError(`cannot read ${path}: ${why(error)}`);
    }
  },
  readAttachment: async (path): Promise<StagedAttachment> => {
    if (shell.readBytes === undefined) throw new CommandError(NO_FILE_ACCESS);
    let bytes: Uint8Array;
    try {
      bytes = await shell.readBytes(path);
    } catch (error) {
      throw new CommandError(`cannot read attachment ${path}: ${why(error)}`);
    }
    if (bytes.byteLength === 0) throw new CommandError(`attachment ${path} is empty`);
    return { filename: baseName(path), mime: mimeOfPath(path), base64: base64Of(bytes) };
  },
});
