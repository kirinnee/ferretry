import type { Instant } from '@ferretry/std';
import type { StatePort } from '@ferretry/kernel/contract';
import { type Question, QUESTION_STATE } from '../../../contract/index.ts';
import { type AskedQuestion, parseAskedQuestion } from '../lib/asked.ts';

/**
 * The one lane every change to a ferret's `question.json` runs in, keyed by the ferret: the writer, the exact-id clear
 * and the withdrawal. Anything with the shape of `KeyedSerialExecutor.run` is one. The kernel's `StatePort` has no
 * compare-and-delete, so "this file still holds Q1, remove it" can only be ONE step by running both halves, and the
 * writer's write, in the same lane (r4 #2: a clear that read Q1 could otherwise delete the Q2 the hook wrote between its
 * read and its remove).
 */
export interface QuestionLane {
  run<T>(ferret: string, work: () => Promise<T>): Promise<T>;
}

/**
 * THE ONE WRITER of `question.json`: the hook's `PreToolUse` payload, read by {@link parseAskedQuestion}'s rules — a
 * whole `AskUserQuestion` call, naming `transcript` — and stored as a {@link Question}, never raw.
 *
 * EVERY PAYLOAD REPLACES THE FILE WHOLE, as today's hook file was "replaced whole by every question": what cannot be
 * stored whole — a payload that does not parse or names another transcript — clears it, so an earlier question is never shown while a different form is open, and the
 * ferret's question is then what its transcript says (today's fallback when the hook's evidence is refused). A call that
 * asks SEVERAL questions is one form and is stored whole (the first question and `more`), so it is shown and its sends are
 * guarded like any other. Answers the question written, or `undefined`. It runs in the ferret's {@link QuestionLane}, like the clear and the withdrawal.
 */
export async function writeAskedQuestion(
  state: StatePort,
  lane: QuestionLane,
  ferret: string,
  payload: string,
  askedAt: Instant,
  transcript: string | undefined,
): Promise<Question | undefined> {
  return await lane.run(ferret, async () => await writeNow(state, ferret, payload, askedAt, transcript));
}

async function writeNow(
  state: StatePort,
  ferret: string,
  payload: string,
  askedAt: Instant,
  transcript: string | undefined,
): Promise<Question | undefined> {
  const asked = parseAskedQuestion(payload, Date.parse(askedAt), transcript);
  const [first, ...more] = asked?.questions ?? [];
  if (asked === undefined || first === undefined || transcript === undefined) {
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
    // Every question of the tool call is kept: a tabbed form is ONE form, shown and guarded whole.
    ...(more.length === 0
      ? {}
      : {
          more: more.map(item => ({
            ...(item.header === undefined ? {} : { header: item.header }),
            text: item.question,
            options: item.options.map(({ label, description }) =>
              description === undefined ? { label } : { label, description },
            ),
            multiple: item.multiple,
          })),
        }),
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
 * is left as it is. The check and the remove are ONE step in the ferret's {@link QuestionLane}, so a writer cannot land a
 * newer question between them.
 */
export async function clearAskedQuestion(
  state: StatePort,
  lane: QuestionLane,
  ferret: string,
  toolUseId?: string,
): Promise<void> {
  await lane.run(ferret, async () => {
    if (toolUseId !== undefined) {
      const read = await state.read(QUESTION_STATE, ferret);
      if (read.ok && read.value !== undefined && read.value.toolUseId !== toolUseId) return;
    }
    await state.remove(QUESTION_STATE, ferret);
  });
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
    const items = [
      {
        question: question.text,
        ...(question.header === undefined ? {} : { header: question.header }),
        options: question.options,
        multiple: question.multiple,
      },
      ...(question.more ?? []).map(item => ({
        question: item.text,
        ...(item.header === undefined ? {} : { header: item.header }),
        options: item.options,
        multiple: item.multiple,
      })),
    ];
    return {
      toolUseId: question.toolUseId,
      questions: items,
      input: {
        questions: items.map(({ multiple, options, ...item }) => ({
          ...item,
          multiSelect: multiple,
          options: options.map(option => ({ ...option })),
        })),
      },
      askedAtMs,
    };
  } catch {
    return undefined;
  }
}
