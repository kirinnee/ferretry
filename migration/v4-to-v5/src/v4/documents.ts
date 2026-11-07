/**
 * Reading one v4 document for the Warden, Projects and Logins steps. Every failure is a {@link V4InputError} whose
 * message names the file (relative to the v4 home) and what is wrong, and never quotes the file: a parser's own
 * message can carry the text it choked on, so it is never passed through.
 */
import { lstat, readFile } from 'node:fs/promises';
import { relative } from 'node:path';

export class V4InputError extends Error {
  override readonly name = 'V4InputError';
}

/** The sentence a step reports for a failure: its own when it is one, a fixed one otherwise. */
export function failureNote(error: unknown, fallback: string): string {
  return error instanceof V4InputError ? error.message : fallback;
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** `undefined` when the file is absent. A link or a folder in its place is refused: a document is never followed. */
export async function readV4Json(home: string, path: string): Promise<unknown> {
  const name = relative(home, path);
  const facts = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw new V4InputError(`${name}: cannot be inspected`);
  });
  if (facts === undefined) return undefined;
  if (!facts.isFile()) throw new V4InputError(`${name}: is not a regular file`);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new V4InputError(`${name}: cannot be read`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new V4InputError(`${name}: is not valid JSON`);
  }
}
