import { parseTranscriptJsonl } from './jsonl.ts';
import type {
  TranscriptAttachment,
  TranscriptEvent,
  TranscriptEventMetadata,
  TranscriptJsonValue,
  TranscriptParseInput,
  TranscriptParseResult,
  TranscriptParser,
  TranscriptRecordContext,
  TranscriptRecordResult,
  TranscriptRole,
} from './types.ts';
import {
  transcriptJsonValue,
  transcriptNumber,
  transcriptObject,
  transcriptQuestions,
  transcriptRecordIssue,
  transcriptString,
  transcriptText,
} from './value.ts';

function codexRole(value: unknown): TranscriptRole | undefined {
  return value === 'user' || value === 'assistant' || value === 'developer' || value === 'system' ? value : undefined;
}

function codexMetadata(
  record: Record<string, unknown>,
  payload: Record<string, unknown>,
  role: TranscriptRole,
  context: TranscriptRecordContext,
  blockIndex?: number,
): TranscriptEventMetadata {
  return {
    harness: 'codex',
    role,
    timestamp: transcriptString(record.timestamp),
    sessionId:
      transcriptString(payload.session_id) ??
      (record.type === 'session_meta' ? transcriptString(payload.id) : undefined) ??
      context.sessionId,
    recordId: transcriptString(payload.id),
    messageId: transcriptString(payload.id),
    turnId: transcriptString(payload.turn_id),
    blockIndex,
  };
}

function codexToolName(itemType: string, payload: Record<string, unknown>): string | undefined {
  const explicit = transcriptString(payload.name);
  if (explicit !== undefined) return explicit;
  switch (itemType) {
    case 'local_shell_call':
      return 'local_shell';
    case 'web_search_call':
      return 'web_search';
    case 'computer_call':
      return 'computer';
    case 'apply_patch_call':
      return 'apply_patch';
    case 'mcp_call':
      return 'mcp';
    default:
      return undefined;
  }
}

function isCodexToolCall(itemType: string): boolean {
  switch (itemType) {
    case 'function_call':
    case 'custom_tool_call':
    case 'local_shell_call':
    case 'web_search_call':
    case 'computer_call':
    case 'apply_patch_call':
    case 'mcp_call':
    case 'tool_call':
      return true;
    default:
      return false;
  }
}

function isCodexToolOutput(itemType: string): boolean {
  switch (itemType) {
    case 'function_call_output':
    case 'custom_tool_call_output':
    case 'local_shell_call_output':
    case 'web_search_call_output':
    case 'computer_call_output':
    case 'apply_patch_call_output':
    case 'mcp_call_output':
    case 'tool_call_output':
    case 'tool_search_output':
      return true;
    default:
      return false;
  }
}

function codexToolFailed(payload: Record<string, unknown>): boolean {
  const status = transcriptString(payload.status)?.toLowerCase();
  return (
    payload.is_error === true ||
    payload.isError === true ||
    payload.success === false ||
    status === 'failed' ||
    status === 'error' ||
    status === 'cancelled'
  );
}

function codexToolInput(payload: Record<string, unknown>): {
  readonly value: TranscriptJsonValue;
  readonly invalidEmbeddedJson: boolean;
} {
  if ('arguments' in payload) {
    const raw = payload.arguments;
    if (typeof raw !== 'string') return { value: transcriptJsonValue(raw), invalidEmbeddedJson: false };
    const trimmed = raw.trim();
    if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) {
      return { value: raw, invalidEmbeddedJson: false };
    }
    try {
      return { value: transcriptJsonValue(JSON.parse(trimmed) as unknown), invalidEmbeddedJson: false };
    } catch {
      return { value: raw, invalidEmbeddedJson: true };
    }
  }
  if ('input' in payload) return { value: transcriptJsonValue(payload.input), invalidEmbeddedJson: false };
  if ('action' in payload) return { value: transcriptJsonValue(payload.action), invalidEmbeddedJson: false };
  if ('execution' in payload) {
    return { value: { execution: transcriptJsonValue(payload.execution) }, invalidEmbeddedJson: false };
  }
  return { value: {}, invalidEmbeddedJson: false };
}

function codexAttachment(block: Record<string, unknown>): TranscriptAttachment | undefined {
  const type = transcriptString(block.type);
  if (type !== 'input_image' && type !== 'image' && type !== 'input_file' && type !== 'file') return undefined;
  const source = transcriptObject(block.source) ?? {};
  const uri =
    transcriptString(block.image_url) ??
    transcriptString(block.file_url) ??
    transcriptString(block.url) ??
    transcriptString(source.url);
  const data = transcriptString(block.data) ?? transcriptString(source.data);
  const mediaType =
    transcriptString(block.media_type) ?? transcriptString(block.mime_type) ?? transcriptString(source.media_type);
  const name = transcriptString(block.name) ?? transcriptString(block.filename);
  return type === 'input_image' || type === 'image'
    ? { kind: 'image', name, mediaType, uri, data }
    : { kind: 'file', name, mediaType, uri, data };
}

function codexError(payload: Record<string, unknown>): { message?: string; code?: string } {
  const nested = transcriptObject(payload.error);
  return {
    message:
      transcriptString(payload.message) ??
      transcriptString(payload.text) ??
      transcriptString(nested?.message) ??
      transcriptString(nested?.error),
    code: transcriptString(payload.code) ?? transcriptString(nested?.code) ?? transcriptString(nested?.type),
  };
}

/** Pure Codex rollout JSONL parser implementing the shared transcript contract. */
export class CodexTranscriptParser implements TranscriptParser {
  readonly harness = 'codex' as const;

  parse(input: TranscriptParseInput): TranscriptParseResult {
    return parseTranscriptJsonl(this, input);
  }

  parseRecord(value: unknown, context: TranscriptRecordContext = {}): TranscriptRecordResult {
    const record = transcriptObject(value);
    if (record === undefined) {
      return {
        events: [],
        issues: [transcriptRecordIssue(this.harness, context, 'invalid-record', 'Codex record must be an object')],
        recognized: true,
      };
    }

    const recordType = transcriptString(record.type);
    const payload = transcriptObject(record.payload) ?? {};
    const itemType = transcriptString(payload.type);
    const events: TranscriptEvent[] = [];
    const issues = [] as TranscriptRecordResult['issues'][number][];

    if ((recordType === 'event_msg' && itemType === 'thread_settings_applied') || recordType === 'turn_context') {
      const settings =
        recordType === 'turn_context'
          ? payload
          : (transcriptObject(payload.thread_settings) ?? transcriptObject(record.thread_settings) ?? {});
      const model = transcriptString(settings.model);
      const reasoningEffort = transcriptString(settings.reasoning_effort) ?? transcriptString(settings.effort);
      if (model === undefined && reasoningEffort === undefined) {
        issues.push(
          transcriptRecordIssue(
            this.harness,
            context,
            'invalid-record',
            'Codex settings record has no settings',
            recordType,
          ),
        );
      } else {
        events.push({
          ...codexMetadata(record, payload, 'system', context),
          kind: 'settings',
          settings: { model, reasoningEffort },
        });
      }
      return { events, issues, recognized: true };
    }

    if (
      recordType === 'event_msg' &&
      (itemType === 'task_started' || itemType === 'task_complete' || itemType === 'turn_aborted')
    ) {
      const state = itemType === 'task_started' ? 'started' : itemType === 'task_complete' ? 'completed' : 'aborted';
      events.push({ ...codexMetadata(record, payload, 'system', context), kind: 'turn', state });
      if (state === 'aborted') {
        const normalized = codexError(payload);
        if (normalized.message !== undefined) {
          events.push({
            ...codexMetadata(record, payload, 'system', context),
            kind: 'error',
            error: { message: normalized.message, code: normalized.code, recoverable: true },
          });
        }
      }
      return { events, issues, recognized: true };
    }

    if (recordType === 'event_msg' && itemType === 'agent_reasoning') {
      const text = transcriptString(payload.text);
      if (text === undefined) {
        issues.push(
          transcriptRecordIssue(
            this.harness,
            context,
            'invalid-record',
            'Codex reasoning record has no text',
            itemType,
          ),
        );
      } else {
        events.push({
          ...codexMetadata(record, payload, 'assistant', context),
          kind: 'reasoning',
          text,
          format: 'reasoning',
        });
      }
      return { events, issues, recognized: true };
    }

    if (recordType === 'event_msg' && itemType === 'token_count') {
      const info = transcriptObject(payload.info) ?? {};
      const last = transcriptObject(info.last_token_usage) ?? {};
      const inputTokens = transcriptNumber(last.input_tokens);
      const outputTokens = transcriptNumber(last.output_tokens);
      const cachedInputTokens = transcriptNumber(last.cached_input_tokens);
      const reasoningTokens = transcriptNumber(last.reasoning_output_tokens);
      const contextWindow = transcriptNumber(info.model_context_window);
      if (
        inputTokens === undefined &&
        outputTokens === undefined &&
        cachedInputTokens === undefined &&
        reasoningTokens === undefined &&
        contextWindow === undefined
      ) {
        return { events, issues, recognized: true };
      }
      const contextTokens = (inputTokens ?? 0) + (outputTokens ?? 0);
      events.push({
        ...codexMetadata(record, payload, 'system', context),
        kind: 'usage',
        usage: {
          inputTokens,
          outputTokens,
          cachedInputTokens,
          reasoningTokens,
          contextTokens,
          contextWindow,
        },
      });
      return { events, issues, recognized: true };
    }

    if (recordType === 'compacted') {
      const text = transcriptString(payload.message);
      if (text === undefined) {
        issues.push(
          transcriptRecordIssue(
            this.harness,
            context,
            'invalid-record',
            'Codex compaction record has no summary',
            recordType,
          ),
        );
      } else {
        events.push({ ...codexMetadata(record, payload, 'system', context), kind: 'message', text });
      }
      return { events, issues, recognized: true };
    }

    if (
      (recordType === 'event_msg' && (itemType === 'error' || itemType === 'stream_error')) ||
      recordType === 'error'
    ) {
      const normalized = codexError(payload);
      if (normalized.message === undefined) {
        issues.push(
          transcriptRecordIssue(
            this.harness,
            context,
            'invalid-record',
            'Codex error record has no message',
            recordType,
          ),
        );
      } else {
        events.push({
          ...codexMetadata(record, payload, 'system', context),
          kind: 'error',
          error: { message: normalized.message, code: normalized.code, recoverable: true },
        });
      }
      return { events, issues, recognized: true };
    }

    if (recordType === 'event_msg' && (itemType === 'user_message' || itemType === 'agent_message')) {
      return { events, issues, recognized: true };
    }
    if (recordType !== 'response_item') return { events, issues, recognized: false };
    if (itemType === undefined) {
      issues.push(
        transcriptRecordIssue(this.harness, context, 'invalid-record', 'Codex response item has no type', recordType),
      );
      return { events, issues, recognized: true };
    }

    if (itemType === 'message') {
      const role = codexRole(payload.role);
      if (role === undefined) {
        issues.push(
          transcriptRecordIssue(this.harness, context, 'invalid-record', 'Codex message has an invalid role', itemType),
        );
        return { events, issues, recognized: true };
      }
      const content = Array.isArray(payload.content) ? payload.content : [payload.content];
      for (let blockIndex = 0; blockIndex < content.length; blockIndex += 1) {
        const value = content[blockIndex];
        const metadata = codexMetadata(record, payload, role, context, blockIndex);
        if (typeof value === 'string') {
          events.push({ ...metadata, kind: 'message', text: value });
          continue;
        }
        const block = transcriptObject(value);
        const blockType = transcriptString(block?.type);
        const text = transcriptString(block?.text) ?? transcriptString(block?.output_text);
        if (
          text !== undefined &&
          (blockType === undefined ||
            blockType === 'input_text' ||
            blockType === 'output_text' ||
            blockType === 'text' ||
            blockType === 'refusal')
        ) {
          events.push({ ...metadata, kind: 'message', text });
          continue;
        }
        if (block !== undefined) {
          const attachment = codexAttachment(block);
          if (attachment !== undefined) {
            events.push({ ...metadata, kind: 'attachment', attachment });
            continue;
          }
        }
        issues.push(
          transcriptRecordIssue(
            this.harness,
            context,
            block === undefined ? 'invalid-record' : 'unsupported-record',
            block === undefined ? 'Codex message block is not an object' : 'Codex message block type is not supported',
            blockType ?? itemType,
          ),
        );
      }
      return { events, issues, recognized: true };
    }

    if (itemType === 'reasoning') {
      const summary = Array.isArray(payload.summary) ? payload.summary : [];
      const content = Array.isArray(payload.content) ? payload.content : [];
      const text = transcriptText([...summary, ...content]);
      if (text === undefined) {
        issues.push(
          transcriptRecordIssue(this.harness, context, 'invalid-record', 'Codex reasoning item has no text', itemType),
        );
      } else {
        events.push({
          ...codexMetadata(record, payload, 'assistant', context),
          kind: 'reasoning',
          text,
          format: 'reasoning',
        });
      }
      return { events, issues, recognized: true };
    }

    if (isCodexToolCall(itemType)) {
      const id = transcriptString(payload.call_id) ?? transcriptString(payload.id);
      const name = codexToolName(itemType, payload);
      if (id === undefined || name === undefined) {
        issues.push(
          transcriptRecordIssue(this.harness, context, 'invalid-record', 'Codex tool call lacks id or name', itemType),
        );
        return { events, issues, recognized: true };
      }
      const input = codexToolInput(payload);
      if (input.invalidEmbeddedJson) {
        issues.push(
          transcriptRecordIssue(
            this.harness,
            context,
            'invalid-tool-input',
            'Codex tool arguments contain malformed embedded JSON',
            itemType,
          ),
        );
      }
      const questions = /^(request_user_input|askuserquestion)$/iu.test(name) ? transcriptQuestions(input.value) : [];
      events.push({
        ...codexMetadata(record, payload, 'assistant', context),
        kind: 'tool-call',
        call: {
          id,
          name,
          input: input.value,
          ...(questions.length > 0 ? { questions } : {}),
        },
      });
      return { events, issues, recognized: true };
    }

    if (isCodexToolOutput(itemType)) {
      const callId = transcriptString(payload.call_id) ?? transcriptString(payload.id);
      if (callId === undefined) {
        issues.push(
          transcriptRecordIssue(this.harness, context, 'invalid-record', 'Codex tool result lacks call id', itemType),
        );
        return { events, issues, recognized: true };
      }
      const content = payload.output ?? payload.result ?? payload.tools ?? payload.content ?? null;
      const text = transcriptText(content);
      events.push({
        ...codexMetadata(record, payload, 'tool', context),
        kind: 'tool-result',
        result: {
          callId,
          content: transcriptJsonValue(content),
          ...(text === undefined ? {} : { text }),
          isError: codexToolFailed(payload),
        },
      });
      return { events, issues, recognized: true };
    }

    issues.push(
      transcriptRecordIssue(
        this.harness,
        context,
        'unsupported-record',
        'Codex response item type is not supported',
        itemType,
      ),
    );
    return { events, issues, recognized: true };
  }
}
