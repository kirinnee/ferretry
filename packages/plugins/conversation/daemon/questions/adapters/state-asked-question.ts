import type { Instant } from '@ferretry/std';
import type { StatePort } from '@ferretry/kernel/contract';
import { type Question, QUESTION_STATE } from '../../../contract/index.ts';
import { type AskedQuestion, parseAskedQuestion } from '../lib/asked.ts';

/**
 * THE ONE WRITER of `question.json`: the hook's `PreToolUse` payload, read by {@link parseAskedQuestion}'s rules — a
 * whole `AskUserQuestion` call, naming `transcript` — and stored as a {@link Question}, never raw.
 *
 * EVERY PAYLOAD REPLACES THE FILE WHOLE, as today's hook file was "replaced whole by every question": what cannot be
 * stored whole — a payload that does not parse, names another transcript, or asks several questions at once (a
 * `Question` holds one) — clears it, so an earlier question is never shown while a different form is open, and the
 * ferret's question is then what its transcript says (today's fallback when the hook's evidence is refused). Answers
 * the question written, or `undefined`.
 */
export async function writeAskedQuestion(
  state: StatePort,
  ferret: string,
  payload: string,
  askedAt: Instant,
  transcript: string | undefined,
): Promise<Question | undefined> {
  const asked = parseAskedQuestion(payload, Date.parse(askedAt), transcript);
  const [first, ...more] = asked?.questions ?? [];
  if (asked === undefined || first === undefined || more.length > 0 || transcript === undefined) {
    await state.remove(QUESTION_STATE, ferret);
    return undefined;
  }
  const question: Question = {
    format: 1,
    toolUseId: asked.toolUseId,
    ...(first.header === undefined ? {} : { header: first.header }),
    text: first.question,
    options: first.options.map(({ label, description }) =>
      description === undefined ? { label } : { label, description },
    ),
    multiple: first.multiple,
    askedAt,
    transcript,
  };
  await state.write(QUESTION_STATE, question, ferret);
  return question;
}

/**
 * The question is no longer the one the ferret is waiting on: it was answered, or withdrawn (the ferret stopped or went
 * away), so `question.json` goes and the question route, the port and the sitrep say none (`contract/port.ts`: "none
 * when it asks nothing"). With `toolUseId`, only that question is cleared: a file that already holds a LATER question
 * is left as it is.
 */
export async function clearAskedQuestion(state: StatePort, ferret: string, toolUseId?: string): Promise<void> {
  if (toolUseId !== undefined) {
    const read = await state.read(QUESTION_STATE, ferret);
    if (read.ok && read.value !== undefined && read.value.toolUseId !== toolUseId) return;
  }
  await state.remove(QUESTION_STATE, ferret);
}

/**
 * The question a ferret's hook recorded (`question.json`), as the evidence {@link withAskedQuestion} lays over the
 * transcript: only when it was proved against the same `transcript` this reader holds. Reading never throws: an
 * absent, unreadable or damaged file is no question.
 */
export async function readAskedQuestion(
  state: StatePort,
  ferret: string,
  transcript: string | undefined,
): Promise<AskedQuestion | undefined> {
  if (transcript === undefined) return undefined;
  try {
    const read = await state.read(QUESTION_STATE, ferret);
    if (!read.ok || read.value === undefined) return undefined;
    const question = read.value;
    const askedAtMs = Date.parse(question.askedAt);
    if (question.transcript !== transcript || !Number.isFinite(askedAtMs)) return undefined;
    return {
      toolUseId: question.toolUseId,
      questions: [
        {
          question: question.text,
          ...(question.header === undefined ? {} : { header: question.header }),
          options: question.options,
          multiple: question.multiple,
        },
      ],
      input: {
        questions: [
          {
            question: question.text,
            ...(question.header === undefined ? {} : { header: question.header }),
            multiSelect: question.multiple,
            options: question.options.map(option => ({ ...option })),
          },
        ],
      },
      askedAtMs,
    };
  } catch {
    return undefined;
  }
}
