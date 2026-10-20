import {
  type ConversationAttachment,
  type ConversationEntry,
  oneLine,
  SHELL_OUTPUT_MAX,
  TOOL_INPUT_MAX,
  TOOL_TEXT_OUTPUT_MAX,
  truncated,
} from './conversation.ts';

/**
 * Tool calls and their results, joined into the entries a conversion carries.
 *
 * Both harnesses record a call and its result as two separate records, often with other records in
 * between, and only the pair means anything: a call with no result is an unanswered request, and a
 * result with no call answers nothing. The readers emit both halves in file order; this joins them at
 * the CALL's position, which is where the agent decided to act.
 */

/** A tool call as a reader found it. */
interface ReadToolCall {
  readonly kind: 'call';
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
  /** Present when the call is a shell command with a native counterpart on the other side. */
  readonly shell?: { readonly command: string; readonly workdir?: string };
  readonly at?: string;
}

/** A tool result as a reader found it. */
interface ReadToolResult {
  readonly kind: 'result';
  readonly id: string;
  readonly output: string;
  readonly failed: boolean;
}

export type ReadItem = ConversationEntry | ReadToolCall | ReadToolResult;

/** The argument keys that say what a call was about, in the order they are preferred. */
const TELLING_KEYS = ['command', 'cmd', 'file_path', 'path', 'pattern', 'query', 'url', 'description', 'prompt'];

/** A call's arguments as one short line: the telling argument when there is one, else the JSON. */
export function toolInputLine(input: unknown): string {
  if (typeof input === 'string') return oneLine(input, TOOL_INPUT_MAX);
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    for (const key of TELLING_KEYS) {
      const value = record[key];
      if (typeof value === 'string' && value.trim() !== '') return oneLine(value, TOOL_INPUT_MAX);
      if (Array.isArray(value) && value.every(part => typeof part === 'string'))
        return oneLine(value.join(' '), TOOL_INPUT_MAX);
    }
  }
  return oneLine(JSON.stringify(input ?? null), TOOL_INPUT_MAX);
}

/** The entries, with each call joined to its result and every result consumed. */
export function pairTools(items: readonly ReadItem[]): {
  readonly entries: readonly ConversationEntry[];
  readonly orphanResults: number;
} {
  const results = new Map<string, ReadToolResult>();
  for (const item of items) if (item.kind === 'result' && !results.has(item.id)) results.set(item.id, item);
  const called = new Set(items.flatMap(item => (item.kind === 'call' ? [item.id] : [])));
  const entries = items.flatMap((item): ConversationEntry[] => {
    if (item.kind === 'result') return [];
    if (item.kind !== 'call') return [item];
    const result = results.get(item.id);
    const at = item.at === undefined ? {} : { at: item.at };
    if (item.shell !== undefined && result !== undefined)
      return [
        {
          kind: 'shell',
          command: item.shell.command,
          ...(item.shell.workdir === undefined ? {} : { workdir: item.shell.workdir }),
          output: truncated(result.output, SHELL_OUTPUT_MAX),
          failed: result.failed,
          ...at,
        },
      ];
    return [
      {
        kind: 'tool',
        name: item.name,
        input: toolInputLine(item.input),
        ...(result === undefined ? {} : { output: truncated(result.output.trim(), TOOL_TEXT_OUTPUT_MAX) }),
        failed: result?.failed ?? false,
        ...at,
      },
    ];
  });
  const orphanResults = [...results.keys()].filter(id => !called.has(id)).length;
  return { entries, orphanResults };
}

/** A `data:` URL split into its media type and base64 bytes, or `undefined` for anything else. */
export function parseDataUrl(url: string): { readonly mediaType: string; readonly data: string } | undefined {
  const match = /^data:([\w.+-]+\/[\w.+-]+);base64,(.+)$/su.exec(url);
  return match === null ? undefined : { mediaType: match[1] as string, data: match[2] as string };
}

/** An image the source referenced by URL rather than embedding. */
export function imageFromUrl(url: string): ConversationAttachment {
  const inline = parseDataUrl(url);
  return inline === undefined
    ? { kind: 'image', uri: url }
    : { kind: 'image', mediaType: inline.mediaType, data: inline.data };
}
