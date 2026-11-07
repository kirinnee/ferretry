import type { StatePort } from '@ferretry/kernel/contract';
import { QUESTION_STATE } from '../../../contract/index.ts';
import { type AskedQuestion, parseAskedQuestion } from '../lib/asked.ts';

/**
 * The question a ferret's harness wrote for it to ask (`question.json` in the ferret's state folder), read as the
 * transcript-proven question or nothing. Reading never throws: an unreadable file is no question.
 */
export async function readAskedQuestion(
  state: StatePort,
  ferret: string,
  transcript: string | undefined,
  modifiedAtMs: number,
): Promise<AskedQuestion | undefined> {
  if (transcript === undefined) return undefined;
  try {
    const read = await state.read<unknown>(QUESTION_STATE, ferret);
    if (!read.ok || read.value === undefined) return undefined;
    return parseAskedQuestion(JSON.stringify(read.value), modifiedAtMs, transcript);
  } catch {
    return undefined;
  }
}
