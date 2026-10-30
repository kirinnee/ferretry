import { open } from 'node:fs/promises';
import { type AskedQuestion, parseAskedQuestion } from '../../../lib/session/question/asked.ts';

/**
 * The question Claude's hook recorded in `file` for the conversation in `transcript`, or `undefined` —
 * no file yet, an unreadable one, or one about something else (`parseAskedQuestion` says what).
 *
 * The text and its time come from ONE open file: the hook replaces the file by renaming, so a stat taken
 * beside a separate read could date one question with another's time.
 */
export async function readAskedQuestion(
  file: string,
  transcript: string | undefined,
): Promise<AskedQuestion | undefined> {
  if (transcript === undefined) return undefined;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(file, 'r');
    const [info, text] = await Promise.all([handle.stat(), handle.readFile('utf8')]);
    return parseAskedQuestion(text, info.mtimeMs, transcript);
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
