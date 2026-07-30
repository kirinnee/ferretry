import { parseTranscriptJsonl } from './jsonl.ts';
import type {
  TranscriptAttachment,
  TranscriptEvent,
  TranscriptEventMetadata,
  TranscriptParseInput,
  TranscriptParseResult,
  TranscriptParser,
  TranscriptRecordContext,
  TranscriptRecordResult,
  TranscriptRole,
  TranscriptUsageEvent,
} from './types.ts';
import {
  transcriptJsonValue,
  transcriptNullableString,
  transcriptNumber,
  transcriptObject,
  transcriptQuestions,
  transcriptRecordIssue,
  transcriptString,
  transcriptText,
} from './value.ts';

function claudeRole(value: unknown): TranscriptRole | undefined {
  return value === 'user' || value === 'assistant' || value === 'developer' || value === 'system' ? value : undefined;
}

function claudeMetadata(
  record: Record<string, unknown>,
  message: Record<string, unknown>,
  role: TranscriptRole,
  blockIndex?: number,
): TranscriptEventMetadata {
  return {
    harness: 'claude',
    role,
    timestamp: transcriptString(record.timestamp),
    sessionId: transcriptString(record.sessionId),
    recordId: transcriptString(record.uuid),
    parentRecordId: transcriptNullableString(record.parentUuid),
    messageId: transcriptString(message.id),
    blockIndex,
  };
}

function claudeAttachment(block: Record<string, unknown>): TranscriptAttachment | undefined {
  const type = transcriptString(block.type);
  if (type !== 'image' && type !== 'document' && type !== 'file' && type !== 'attachment') return undefined;

  const source = transcriptObject(block.source) ?? {};
  const name = transcriptString(block.name) ?? transcriptString(source.name);
  const mediaType =
    transcriptString(block.media_type) ??
    transcriptString(block.mediaType) ??
    transcriptString(source.media_type) ??
    transcriptString(source.mediaType);
  const uri =
    transcriptString(block.url) ??
    transcriptString(block.uri) ??
    transcriptString(block.file_id) ??
    transcriptString(source.url) ??
    transcriptString(source.uri);
  const data = transcriptString(block.data) ?? transcriptString(source.data);

  if (type === 'image') return { kind: 'image', name, mediaType, uri, data };
  if (type === 'document') {
    return {
      kind: 'document',
      name,
      mediaType,
      uri,
      data,
      text: transcriptString(block.text) ?? transcriptString(source.text),
    };
  }
  return { kind: 'file', name, mediaType, uri, data };
}

function claudeErrorMessage(value: unknown): { message?: string; code?: string } {
  if (typeof value === 'string') return { message: value };
  const error = transcriptObject(value);
  return {
    message: transcriptString(error?.message) ?? transcriptString(error?.error),
    code: transcriptString(error?.code) ?? transcriptString(error?.type),
  };
}

function claudeUsage(
  record: Record<string, unknown>,
  message: Record<string, unknown>,
): TranscriptUsageEvent | undefined {
  const usage = transcriptObject(message.usage);
  if (usage === undefined) return undefined;

  const inputTokens = transcriptNumber(usage.input_tokens);
  const outputTokens = transcriptNumber(usage.output_tokens);
  const cachedInputTokens = transcriptNumber(usage.cache_read_input_tokens);
  const cacheCreationInputTokens = transcriptNumber(usage.cache_creation_input_tokens);
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cachedInputTokens === undefined &&
    cacheCreationInputTokens === undefined
  ) {
    return undefined;
  }

  const contextParts = [inputTokens, cachedInputTokens, cacheCreationInputTokens].filter(
    (value): value is number => value !== undefined,
  );
  const contextTokens = contextParts.length > 0 ? contextParts.reduce((total, value) => total + value, 0) : undefined;
  return {
    ...claudeMetadata(record, message, 'system'),
    kind: 'usage',
    usage: {
      inputTokens,
      outputTokens,
      cachedInputTokens,
      cacheCreationInputTokens,
      contextTokens,
      model: transcriptString(message.model),
    },
  };
}

/** Pure Claude Code JSONL parser implementing the shared transcript contract. */
export class ClaudeTranscriptParser implements TranscriptParser {
  readonly harness = 'claude' as const;

  parse(input: TranscriptParseInput): TranscriptParseResult {
    return parseTranscriptJsonl(this, input);
  }

  parseRecord(value: unknown, context: TranscriptRecordContext = {}): TranscriptRecordResult {
    const record = transcriptObject(value);
    if (record === undefined) {
      return {
        events: [],
        issues: [transcriptRecordIssue(this.harness, context, 'invalid-record', 'Claude record must be an object')],
        recognized: true,
      };
    }

    const recordType = transcriptString(record.type);
    const message = transcriptObject(record.message) ?? {};
    const events: TranscriptEvent[] = [];
    const issues = [] as TranscriptRecordResult['issues'][number][];

    if (recordType === 'attachment') {
      const attachment = transcriptObject(record.attachment);
      const origin = transcriptObject(attachment?.origin);
      const text = transcriptString(attachment?.prompt);
      if (
        attachment?.type === 'queued_command' &&
        attachment.commandMode === 'prompt' &&
        origin?.kind === 'human' &&
        text !== undefined &&
        text.trim().length > 0
      ) {
        events.push({
          ...claudeMetadata(record, message, 'user'),
          kind: 'attachment',
          attachment: { kind: 'queued-command', text, origin: 'human' },
        });
      }
      return { events, issues, recognized: true };
    }

    if (recordType === 'system' && record.subtype === 'bridge_status') {
      const url = transcriptString(record.url);
      if (url !== undefined && /^https:\/\/claude\.ai\/code\//u.test(url)) {
        events.push({
          ...claudeMetadata(record, message, 'system'),
          kind: 'attachment',
          attachment: { kind: 'remote-control', url },
        });
      }
      return { events, issues, recognized: true };
    }

    if (recordType === 'system' && (record.subtype === 'error' || record.subtype === 'api_error')) {
      const normalized = claudeErrorMessage(record.error ?? record.message ?? record.content);
      if (normalized.message === undefined) {
        issues.push(
          transcriptRecordIssue(
            this.harness,
            context,
            'invalid-record',
            'Claude error record has no message',
            recordType,
          ),
        );
      } else {
        events.push({
          ...claudeMetadata(record, message, 'system'),
          kind: 'error',
          error: { message: normalized.message, code: normalized.code, recoverable: true },
        });
      }
      return { events, issues, recognized: true };
    }

    const role = claudeRole(message.role) ?? claudeRole(recordType);
    if (role === undefined) return { events, issues, recognized: false };

    const content = message.content ?? record.content;
    const blocks = Array.isArray(content) ? content : content === undefined ? [] : [content];
    for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
      const value = blocks[blockIndex];
      const metadata = claudeMetadata(record, message, role, blockIndex);
      if (typeof value === 'string') {
        events.push({ ...metadata, kind: 'message', text: value });
        continue;
      }

      const block = transcriptObject(value);
      const blockType = transcriptString(block?.type);
      if (block === undefined || blockType === undefined) {
        issues.push(
          transcriptRecordIssue(
            this.harness,
            context,
            'invalid-record',
            'Claude content block is not typed',
            recordType,
          ),
        );
        continue;
      }

      if (blockType === 'text' && typeof block.text === 'string') {
        events.push({ ...metadata, kind: 'message', text: block.text });
        continue;
      }
      if (blockType === 'thinking' && role === 'assistant' && typeof block.thinking === 'string') {
        events.push({ ...metadata, kind: 'reasoning', text: block.thinking, format: 'thinking' });
        continue;
      }
      if (blockType === 'tool_use' && role === 'assistant') {
        const id = transcriptString(block.id);
        const name = transcriptString(block.name);
        if (id === undefined || name === undefined) {
          issues.push(
            transcriptRecordIssue(
              this.harness,
              context,
              'invalid-record',
              'Claude tool call lacks id or name',
              blockType,
            ),
          );
          continue;
        }
        const questions = name === 'AskUserQuestion' ? transcriptQuestions(block.input) : [];
        events.push({
          ...metadata,
          kind: 'tool-call',
          call: {
            id,
            name,
            input: transcriptJsonValue(block.input),
            ...(questions.length > 0 ? { questions } : {}),
          },
        });
        continue;
      }
      if (blockType === 'tool_result') {
        const callId = transcriptString(block.tool_use_id);
        if (callId === undefined) {
          issues.push(
            transcriptRecordIssue(
              this.harness,
              context,
              'invalid-record',
              'Claude tool result lacks call id',
              blockType,
            ),
          );
          continue;
        }
        const text = transcriptText(block.content);
        events.push({
          ...claudeMetadata(record, message, 'tool', blockIndex),
          kind: 'tool-result',
          result: {
            callId,
            content: transcriptJsonValue(block.content),
            ...(text === undefined ? {} : { text }),
            isError: block.is_error === true || block.isError === true,
          },
        });
        continue;
      }

      const attachment = claudeAttachment(block);
      if (attachment !== undefined) {
        events.push({ ...metadata, kind: 'attachment', attachment });
        continue;
      }
      if (blockType === 'error') {
        const normalized = claudeErrorMessage(block);
        if (normalized.message !== undefined) {
          events.push({
            ...claudeMetadata(record, message, 'system', blockIndex),
            kind: 'error',
            error: { message: normalized.message, code: normalized.code, recoverable: true },
          });
        } else {
          issues.push(
            transcriptRecordIssue(
              this.harness,
              context,
              'invalid-record',
              'Claude error block has no message',
              blockType,
            ),
          );
        }
        continue;
      }

      issues.push(
        transcriptRecordIssue(
          this.harness,
          context,
          'unsupported-record',
          'Claude content block type is not supported',
          blockType,
        ),
      );
    }

    if (role === 'assistant' && message.stop_reason === 'end_turn') {
      events.push({ ...claudeMetadata(record, message, 'system'), kind: 'turn', state: 'completed' });
    }
    if (role === 'assistant') {
      const usage = claudeUsage(record, message);
      if (usage !== undefined) events.push(usage);
    }

    return { events, issues, recognized: true };
  }
}
