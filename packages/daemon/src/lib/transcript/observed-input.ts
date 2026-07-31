import type { ObservedHumanInput, TranscriptInputObserver, TranscriptObservationContext } from './types.ts';
import { transcriptObject, transcriptString } from './value.ts';

export const CLAUDE_INPUT_SHAPE_VERSION = 1;
export const CODEX_INPUT_SHAPE_VERSION = 1;

const CLAUDE_REMOVE_RING_LIMIT = 64;

function proofKey(recordId: string | undefined, context: TranscriptObservationContext): string {
  if (recordId !== undefined && recordId.trim().length > 0) return recordId;
  const start = context.byteOffset ?? 0;
  return `${context.source ?? ''}#${start}#${start + (context.byteLength ?? 0)}`;
}

function claudeUserText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    const block = transcriptObject(content);
    return block?.type === 'text' ? transcriptString(block.text) : undefined;
  }
  const parts = content.flatMap(value => {
    if (typeof value === 'string') return [value];
    const block = transcriptObject(value);
    const text = block?.type === 'text' ? transcriptString(block.text) : undefined;
    return text === undefined ? [] : [text];
  });
  return parts.length > 0 ? parts.join('\n') : undefined;
}

interface ClaudeRemoveOperation {
  readonly content: string;
  readonly timestamp?: string;
}

/** Pure stateful matcher for Claude's normal user and native busy-queue proof records. */
export class ClaudeObservedInputObserver implements TranscriptInputObserver {
  readonly harness = 'claude' as const;
  private readonly removeRing: ClaudeRemoveOperation[] = [];

  reset(): void {
    this.removeRing.length = 0;
  }

  observe(value: unknown, context: TranscriptObservationContext): readonly ObservedHumanInput[] {
    const record = transcriptObject(value);
    if (record === undefined) return [];

    if (record.type === 'queue-operation') {
      if (record.operation === 'remove') {
        const content = transcriptString(record.content);
        if (content !== undefined) {
          this.removeRing.push({ content, timestamp: transcriptString(record.timestamp) });
          if (this.removeRing.length > CLAUDE_REMOVE_RING_LIMIT) this.removeRing.shift();
        }
      }
      return [];
    }

    if (record.type === 'attachment') {
      const attachment = transcriptObject(record.attachment);
      const origin = transcriptObject(attachment?.origin);
      const text = transcriptString(attachment?.prompt);
      if (
        attachment?.type !== 'queued_command' ||
        attachment.commandMode !== 'prompt' ||
        origin?.kind !== 'human' ||
        text === undefined ||
        text.trim().length === 0
      ) {
        return [];
      }
      const observedAt = this.takeRemoveTimestamp(text) ?? context.observedAt;
      if (observedAt === undefined) return [];
      const originatedAt = transcriptString(attachment.timestamp) ?? transcriptString(record.timestamp);
      return [
        {
          harness: this.harness,
          text,
          proof: 'native-queue-drain',
          observedAt,
          ...(originatedAt === undefined ? {} : { originatedAt }),
          proofKey: proofKey(transcriptString(record.uuid), context),
          shapeVersion: CLAUDE_INPUT_SHAPE_VERSION,
        },
      ];
    }

    const message = transcriptObject(record.message);
    if (record.type !== 'user' || message?.role !== 'user') return [];
    const text = claudeUserText(message.content ?? record.content);
    if (text === undefined || text.trim().length === 0) return [];
    const observedAt = transcriptString(record.timestamp) ?? context.observedAt;
    if (observedAt === undefined) return [];
    return [
      {
        harness: this.harness,
        text,
        proof: 'normal-user-record',
        observedAt,
        proofKey: proofKey(transcriptString(record.uuid), context),
        shapeVersion: CLAUDE_INPUT_SHAPE_VERSION,
      },
    ];
  }

  private takeRemoveTimestamp(text: string): string | undefined {
    for (let index = this.removeRing.length - 1; index >= 0; index -= 1) {
      if (this.removeRing[index]?.content !== text) continue;
      return this.removeRing.splice(index, 1)[0]?.timestamp;
    }
    return undefined;
  }
}

function isCodexPreamble(text: string): boolean {
  const head = text.trimStart();
  return (
    head.startsWith('<environment_context>') ||
    head.startsWith('<user_instructions>') ||
    head.startsWith('<user_environment>')
  );
}

/** Pure observer for the single canonical Codex user-message proof shape. */
export class CodexObservedInputObserver implements TranscriptInputObserver {
  readonly harness = 'codex' as const;

  reset(): void {}

  observe(value: unknown, context: TranscriptObservationContext): readonly ObservedHumanInput[] {
    const record = transcriptObject(value);
    if (record === undefined || record.type !== 'response_item') return [];
    const payload = transcriptObject(record.payload);
    if (payload?.type !== 'message' || payload.role !== 'user') return [];

    const content = Array.isArray(payload.content) ? payload.content : [payload.content];
    const parts: string[] = [];
    for (const value of content) {
      if (typeof value === 'string') {
        parts.push(value);
        continue;
      }
      const block = transcriptObject(value);
      const type = transcriptString(block?.type);
      const text = transcriptString(block?.text) ?? transcriptString(block?.output_text);
      if (text !== undefined && (type === undefined || type === 'input_text')) parts.push(text);
    }
    const text = parts.join('\n');
    if (text.trim().length === 0 || isCodexPreamble(text)) return [];
    const observedAt = transcriptString(record.timestamp) ?? context.observedAt;
    if (observedAt === undefined) return [];
    return [
      {
        harness: this.harness,
        text,
        proof: 'normal-user-record',
        observedAt,
        proofKey: proofKey(transcriptString(payload.id), context),
        shapeVersion: CODEX_INPUT_SHAPE_VERSION,
      },
    ];
  }
}
