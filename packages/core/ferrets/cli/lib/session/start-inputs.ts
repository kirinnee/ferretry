import type { VerbInvocation } from '@ferretry/kernel/manifest';
import { text, typed } from '../verb-io.ts';
import { SessionCommandError } from './errors.ts';

/** The shell's file reader (`CliContext.readText`): UTF-8 text from a path against the CLI's working directory. */
export type ReadText = (path: string) => Promise<string>;

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
