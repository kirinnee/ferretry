import { classifyCommand, classifyToolName } from './command-classifier.ts';
import type { OpenToolInfo } from './inflight-report.ts';

interface ChatToolUse {
  readonly type: string;
  readonly timestamp?: string;
  readonly data?: { readonly toolUseId?: string; readonly name?: string; readonly input?: unknown };
}

function isToolUse(value: unknown): value is ChatToolUse {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { readonly type?: unknown }).type === 'tool.use' &&
    typeof (value as { readonly data?: unknown }).data === 'object'
  );
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
  for (const record of chatRecords)
    if (isToolUse(record) && record.data?.toolUseId) byId.set(record.data.toolUseId, record);
  return openToolIds.map(toolUseId => {
    const record = byId.get(toolUseId);
    const name = record?.data?.name ?? '?';
    const input = record?.data?.input;
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
