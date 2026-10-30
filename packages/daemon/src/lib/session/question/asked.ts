import {
  normalizeTranscriptQuestions,
  transcriptJsonValue,
  transcriptObject,
  transcriptString,
} from '../../transcript/value.ts';
import type { TranscriptEvent, TranscriptJsonValue, TranscriptQuestion } from '../../transcript/types.ts';

/**
 * A QUESTION CLAUDE IS ASKING, as its own `PreToolUse` hook recorded it — the evidence the transcript
 * does not hold yet.
 *
 * WHY THE TRANSCRIPT IS NOT ENOUGH. Claude Code 2.1.281 keeps an `AskUserQuestion` call out of its
 * transcript for as long as the form is open: the assistant record carrying it is written in the same
 * flush as its `tool_result`, once the form is answered or cancelled. Measured on a real pane — asked
 * 04:33:35.961, on disk at 04:36:02 with the answer — on Haiku and Opus alike. A projection that reads
 * only the transcript therefore never sees an open question: the session reads `working`, no card is
 * drawn, and the only way to answer is the Console.
 *
 * The fleet's fixed layer installs a `PreToolUse` hook for `AskUserQuestion` that copies the hook's
 * payload into the session's own file (`FY_QUESTION_FILE`); it fires before the form is drawn, with the
 * real `tool_use_id` and the whole input. This module reads that file, and decides when it still
 * describes the form on screen.
 */
export interface AskedQuestion {
  readonly toolUseId: string;
  readonly questions: readonly TranscriptQuestion[];
  readonly input: TranscriptJsonValue;
  /** When the hook wrote the file: after the call was made, before the form was drawn. */
  readonly askedAtMs: number;
}

/** The only tool whose asking is recorded: Claude's structured question. */
const CLAUDE_QUESTION_TOOL = 'AskUserQuestion';

/**
 * The hook's payload, or `undefined` when it is not a whole, recognizable `AskUserQuestion` call for
 * `transcript`.
 *
 * Refusing is always safe: without this evidence the session falls back to what the transcript says,
 * which is how it behaved before the hook existed. So a payload naming another transcript (a different
 * conversation, a subagent's own file), another tool, or a question it cannot read whole is ignored
 * rather than half-read.
 */
export function parseAskedQuestion(
  text: string,
  askedAtMs: number,
  transcript: string | undefined,
): AskedQuestion | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const payload = transcriptObject(parsed);
  if (payload === undefined || !Number.isFinite(askedAtMs)) return undefined;
  if (transcriptString(payload.hook_event_name) !== 'PreToolUse') return undefined;
  if (transcriptString(payload.tool_name) !== CLAUDE_QUESTION_TOOL) return undefined;
  const toolUseId = transcriptString(payload.tool_use_id);
  if (toolUseId === undefined || toolUseId.trim() === '') return undefined;
  const path = transcriptString(payload.transcript_path);
  if (transcript === undefined || path !== transcript) return undefined;
  const normalized = normalizeTranscriptQuestions(payload.tool_input);
  if (normalized.questions.length === 0 || normalized.invalidEntries > 0) return undefined;
  return {
    toolUseId,
    questions: normalized.questions,
    input: transcriptJsonValue(payload.tool_input),
    askedAtMs,
  };
}

/** Whether a transcript event names this call, as the call itself or as its result. */
const names = (event: TranscriptEvent, toolUseId: string): boolean =>
  (event.kind === 'tool-call' && event.call.id === toolUseId) ||
  (event.kind === 'tool-result' && event.result.callId === toolUseId);

/** Whether a transcript event was written after the question was asked. */
const after = (event: TranscriptEvent, askedAtMs: number): boolean => {
  const at = event.timestamp === undefined ? Number.NaN : Date.parse(event.timestamp);
  return Number.isFinite(at) && at > askedAtMs;
};

/**
 * The transcript tail with the recorded question appended as the call it will become, while — and only
 * while — that question is still the form on screen.
 *
 * STILL OPEN means the transcript has nothing newer: no record of the call or of its result, and no
 * event at all timestamped after it was asked. Claude writes nothing while the form waits, and the
 * moment it is answered or cancelled the call and its result land together, so the transcript takes
 * over from here exactly as it did before. An event newer than the hook — a later turn, a revived
 * pane, a call that has since scrolled out of the tail — retires the file for good, so a stale record
 * can never bring back a form that is gone.
 */
export function withAskedQuestion(
  events: readonly TranscriptEvent[],
  asked: AskedQuestion | undefined,
): readonly TranscriptEvent[] {
  if (asked === undefined) return events;
  if (events.some(event => names(event, asked.toolUseId) || after(event, asked.askedAtMs))) return events;
  return [
    ...events,
    {
      kind: 'tool-call',
      harness: 'claude',
      role: 'assistant',
      timestamp: new Date(asked.askedAtMs).toISOString(),
      call: { id: asked.toolUseId, name: CLAUDE_QUESTION_TOOL, input: asked.input, questions: asked.questions },
    },
  ];
}
