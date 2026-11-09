import type { VerbInvocation } from '@ferretry/kernel/manifest';
import { list, text, typed } from '../verb-io.ts';
import { basename } from 'node:path';
import type { InitialAttachment } from '../../../contract/index.ts';
import { SessionCommandError } from './errors.ts';

/** The shell's file reader (`CliContext.readText`): UTF-8 text from a path against the CLI's working directory. */
export type ReadText = (path: string) => Promise<string>;

/** The shell's byte reader (`CliContext.readBytes`): the raw bytes of a path, by the same rules as {@link ReadText}. */
export type ReadBytes = (path: string) => Promise<Uint8Array>;

/**
 * The text of a `--prompt-file`, read here on the caller's machine and sent as the prompt: a path never reaches the
 * daemon. Today's `SessionFiles.readText`: trimmed, and an unreadable path is the caller's own mistake that names the
 * path they typed (the source let the runtime's ENOENT stack out, which told a user nothing about which flag was
 * wrong). An empty file reads as ''; the start decides what a missing prompt means for its mode.
 */
export async function readPromptFile(path: string, read: ReadText | undefined): Promise<string> {
  if (read === undefined)
    throw new SessionCommandError(
      '--prompt-file needs the shell’s file reader, which this fy does not give a verb yet',
      1,
    );
  try {
    return (await read(path)).trim();
  } catch (error) {
    throw new SessionCommandError(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * The prompt a start or a new is given.
 *
 * Today's `fy start` puts the file's text AFTER the typed words, a blank line between (`--prompt-file` adds to the
 * command line); today's `fy new` takes the file as THE brief and the typed words give way to it. A file that is empty
 * after trimming adds nothing to a start and leaves a new with no brief.
 */
export function promptWith(role: 'start' | 'new', typedWords: string | undefined, filed: string): string | undefined {
  const parts = role === 'start' ? [typedWords?.trim() ?? '', filed] : [filed];
  const prompt = parts.filter(part => part !== '').join('\n\n');
  return prompt === '' ? undefined : prompt;
}

/** The path `--prompt-file` names, when it was typed; a bare `--prompt-file` with no path is refused. */
export function promptFilePath(invocation: VerbInvocation): string | undefined {
  if (!typed(invocation, 'prompt-file')) return undefined;
  const path = text(invocation, 'prompt-file')?.trim();
  if (path === undefined || path === '')
    throw new SessionCommandError('--prompt-file needs the path of a file to read');
  return path;
}

/**
 * The idempotency key `--request-id` names, when it was typed (today's `start` and `restart`): re-running the verb
 * with the same key answers the same ferret instead of acting twice. A blank key is refused, as today's restart does.
 */
export function requestIdOf(invocation: VerbInvocation): string | undefined {
  if (!typed(invocation, 'request-id')) return undefined;
  const id = text(invocation, 'request-id')?.trim();
  if (id === undefined || id === '') throw new SessionCommandError('--request-id must not be blank');
  return id;
}

/** The image types worth stating: today's CLI stated a type only for an image (a document's is the receiver's to decide). */
const IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  ico: 'image/x-icon',
  heic: 'image/heic',
};

/**
 * The paths `-f/--file` names (`-f a -f b`, or `--file a`); a bare flag with no path is refused. Each spelling keeps the
 * order it was typed in, but the shell's parser hands the two spellings over under separate keys, so a mix
 * (`-f a --file b`) lists the `--file` paths first. Only the order of the section's lines follows from it.
 */
export function attachmentPaths(invocation: VerbInvocation): readonly string[] {
  if (!typed(invocation, 'file', 'f')) return [];
  const paths = [...list(invocation, 'file'), ...list(invocation, 'f')].map(path => path.trim());
  if (paths.length === 0 || paths.some(path => path === ''))
    throw new SessionCommandError('-f/--file needs the path of a file to attach');
  return paths;
}

/**
 * The files attached to a start's opening message, read HERE on the caller's machine as raw bytes and sent inline as
 * base64 (today's `SessionFiles.readAttachment`): a path never reaches the daemon. The name sent is the file's own name; an
 * unreadable path is the caller's own mistake naming the path they typed, and an empty file is refused. Two files of one
 * name are refused, because they would be stored under one name and the second would silently replace the first.
 */
export async function readAttachments(
  paths: readonly string[],
  read: ReadBytes | undefined,
): Promise<readonly InitialAttachment[]> {
  if (paths.length === 0) return [];
  if (read === undefined)
    throw new SessionCommandError('-f/--file needs the shell’s byte reader, which this fy does not give a verb yet', 1);
  const names = new Set<string>();
  const attachments: InitialAttachment[] = [];
  for (const path of paths) {
    let bytes: Uint8Array;
    try {
      bytes = await read(path);
    } catch (error) {
      throw new SessionCommandError(
        `cannot read attachment ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (bytes.byteLength === 0) throw new SessionCommandError(`attachment ${path} is empty`);
    const filename = basename(path);
    if (names.has(filename))
      throw new SessionCommandError(`two attachments are named ${filename}: each file attached needs its own name`);
    names.add(filename);
    const mime = IMAGE_TYPES[filename.split('.').at(-1)?.toLowerCase() ?? ''];
    attachments.push({
      filename,
      ...(mime === undefined || !filename.includes('.') ? {} : { mime }),
      base64: Buffer.from(bytes).toString('base64'),
    });
  }
  return attachments;
}
