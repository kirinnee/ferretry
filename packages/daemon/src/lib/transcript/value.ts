import type {
  TranscriptHarness,
  TranscriptIssue,
  TranscriptIssueCode,
  TranscriptJsonValue,
  TranscriptQuestion,
  TranscriptRecordContext,
} from './types.ts';

export function transcriptObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function transcriptString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function transcriptNullableString(value: unknown): string | null | undefined {
  return value === null || typeof value === 'string' ? value : undefined;
}

export function transcriptNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function transcriptJsonValue(value: unknown, seen: ReadonlySet<object> = new Set()): TranscriptJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'object') return null;
  if (seen.has(value)) return null;

  const nextSeen = new Set(seen);
  nextSeen.add(value);
  if (Array.isArray(value)) return value.map(item => transcriptJsonValue(item, nextSeen));

  const normalized: Record<string, TranscriptJsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) normalized[key] = transcriptJsonValue(item, nextSeen);
  }
  return normalized;
}

export function transcriptText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) {
    const item = transcriptObject(value);
    return transcriptString(item?.text) ?? transcriptString(item?.output_text);
  }

  const parts: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      parts.push(item);
      continue;
    }
    const block = transcriptObject(item);
    const text = transcriptString(block?.text) ?? transcriptString(block?.output_text);
    if (text !== undefined) parts.push(text);
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
}

export interface TranscriptQuestionNormalization {
  readonly questions: readonly TranscriptQuestion[];
  readonly invalidEntries: number;
}

export function normalizeTranscriptQuestions(input: unknown): TranscriptQuestionNormalization {
  const questions = transcriptObject(input)?.questions;
  if (!Array.isArray(questions)) return { questions: [], invalidEntries: questions === undefined ? 0 : 1 };

  const normalized: TranscriptQuestion[] = [];
  let invalidEntries = 0;
  for (const value of questions) {
    const question = transcriptObject(value);
    const text = transcriptString(question?.question);
    if (text === undefined) {
      invalidEntries += 1;
      continue;
    }

    const options: TranscriptQuestion['options'][number][] = [];
    if (question?.options !== undefined && !Array.isArray(question.options)) invalidEntries += 1;
    if (Array.isArray(question?.options)) {
      for (const value of question.options) {
        const option = transcriptObject(value);
        const label = transcriptString(option?.label);
        if (label === undefined) {
          invalidEntries += 1;
          continue;
        }
        options.push({
          label,
          description: transcriptString(option?.description),
          preview: transcriptString(option?.preview),
        });
      }
    }

    normalized.push({
      question: text,
      header: transcriptString(question?.header),
      options,
      multiple: question?.multiSelect === true || question?.multi_select === true,
    });
  }
  return { questions: normalized, invalidEntries };
}

export function transcriptRecordIssue(
  harness: TranscriptHarness,
  context: TranscriptRecordContext,
  code: TranscriptIssueCode,
  message: string,
  recordType?: string,
  itemType?: string,
  blockType?: string,
): TranscriptIssue {
  return {
    harness,
    code,
    message,
    recoverable: true,
    source: context.source,
    line: context.line,
    recordType,
    itemType,
    blockType,
  };
}
