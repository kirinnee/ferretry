import { classifyCommand, classifyToolName } from './command-classifier.ts';
import type { OpenToolInfo } from './inflight-report.ts';

interface ChatToolUse {
  readonly toolUseId: string;
  readonly timestamp?: string;
  readonly name?: string;
  readonly input?: unknown;
}

/**
 * The record shape the harness journal carries: `{ type: 'tool.use', data: { toolUseId, … } }`.
 */
function fromChatRecord(value: object): ChatToolUse | undefined {
  if ((value as { readonly type?: unknown }).type !== 'tool.use') return undefined;
  const data = (value as { readonly data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return undefined;
  const fields = data as { readonly toolUseId?: unknown; readonly name?: unknown; readonly input?: unknown };
  if (typeof fields.toolUseId !== 'string' || fields.toolUseId === '') return undefined;
  const timestamp = (value as { readonly timestamp?: unknown }).timestamp;
  return {
    toolUseId: fields.toolUseId,
    ...(typeof timestamp === 'string' ? { timestamp } : {}),
    ...(typeof fields.name === 'string' ? { name: fields.name } : {}),
    input: fields.input,
  };
}

/**
 * The daemon's OWN normalized transcript event: `{ kind: 'tool-call', call: { id, name, input } }`.
 *
 * Accepted here because it is what `TranscriptSource.read` produces, and once a session records its
 * transcript that is where this join's evidence actually comes from. Translating it into the
 * journal shape first would be a second vocabulary for the same fact, and the failure mode of
 * getting that translation wrong is silent: an unrecognized record makes an open tool `unknown`,
 * which the gate refuses on — a migration blocked by a shape mismatch, reported as danger.
 */
function fromTranscriptEvent(value: object): ChatToolUse | undefined {
  if ((value as { readonly kind?: unknown }).kind !== 'tool-call') return undefined;
  const call = (value as { readonly call?: unknown }).call;
  if (typeof call !== 'object' || call === null) return undefined;
  const fields = call as { readonly id?: unknown; readonly name?: unknown; readonly input?: unknown };
  if (typeof fields.id !== 'string' || fields.id === '') return undefined;
  const timestamp = (value as { readonly timestamp?: unknown }).timestamp;
  return {
    toolUseId: fields.id,
    ...(typeof timestamp === 'string' ? { timestamp } : {}),
    ...(typeof fields.name === 'string' ? { name: fields.name } : {}),
    input: fields.input,
  };
}

function toolUse(value: unknown): ChatToolUse | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  return fromChatRecord(value) ?? fromTranscriptEvent(value);
}

/** Produces a stable, bounded description without treating opaque input as harmless. */
export function summarizeToolInput(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return name;
  const fields = input as Readonly<Record<string, unknown>>;
  if (typeof fields.command === 'string') return fields.command.trim();
  for (const key of ['file_path', 'path', 'pattern']) if (typeof fields[key] === 'string') return fields[key] as string;
  try {
    return JSON.stringify(fields);
  } catch {
    return '(uninspectable input)';
  }
}

/** Joins in-flight tool IDs with transcript records; missing evidence remains unknown. */
export function joinOpenTools(
  openToolIds: readonly string[],
  chatRecords: readonly unknown[],
): readonly OpenToolInfo[] {
  const byId = new Map<string, ChatToolUse>();
  for (const record of chatRecords) {
    const use = toolUse(record);
    if (use !== undefined) byId.set(use.toolUseId, use);
  }
  return openToolIds.map(toolUseId => {
    const record = byId.get(toolUseId);
    const name = record?.name ?? '?';
    const input = record?.input;
    const hasCommand =
      name === 'Bash' && typeof (input as { readonly command?: unknown } | undefined)?.command === 'string';
    return {
      toolUseId,
      name,
      summary: record ? summarizeToolInput(name, input) : '(command not found in chat tail)',
      startedAt: record?.timestamp,
      verdict: hasCommand ? classifyCommand((input as { readonly command: string }).command) : classifyToolName(name),
    };
  });
}
