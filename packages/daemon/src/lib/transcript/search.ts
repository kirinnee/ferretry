import type { TranscriptAttachment, TranscriptEvent, TranscriptRole } from './types.ts';

export interface TranscriptSearchOptions {
  readonly limit?: number;
  readonly caseSensitive?: boolean;
  readonly roles?: readonly TranscriptRole[];
}

export interface TranscriptSearchMatch {
  readonly eventIndex: number;
  readonly harness: TranscriptEvent['harness'];
  readonly role: TranscriptRole;
  readonly kind: TranscriptEvent['kind'];
  readonly turn: number;
  readonly snippet: string;
  readonly timestamp?: string;
}

const SNIPPET_BEFORE = 48;
const SNIPPET_AFTER = 96;

function attachmentText(attachment: TranscriptAttachment): string | undefined {
  switch (attachment.kind) {
    case 'remote-control':
      return attachment.url;
    case 'document':
      return attachment.text ?? attachment.name ?? attachment.uri;
    case 'image':
    case 'audio':
    case 'file':
      return attachment.name ?? attachment.uri;
  }
}

function searchableText(event: TranscriptEvent): string | undefined {
  switch (event.kind) {
    case 'message':
    case 'reasoning':
      return event.text;
    case 'tool-call': {
      const questions = event.call.questions?.map(question => question.question) ?? [];
      return [event.call.name, ...questions].join('\n');
    }
    case 'tool-result':
      return event.result.text;
    case 'attachment':
      return attachmentText(event.attachment);
    case 'error':
      return event.error.message;
    case 'settings':
    case 'turn':
    case 'usage':
      return undefined;
  }
}

function snippetAround(text: string, at: number, queryLength: number): string {
  const start = Math.max(0, at - SNIPPET_BEFORE);
  const end = Math.min(text.length, at + queryLength + SNIPPET_AFTER);
  const normalized = text.slice(start, end).replace(/\s+/gu, ' ').trim();
  return `${start > 0 ? '… ' : ''}${normalized}${end < text.length ? ' …' : ''}`;
}

/** Search every explicitly text-bearing event without inspecting harness-specific records. */
export function searchTranscript(
  events: readonly TranscriptEvent[],
  query: string,
  options: TranscriptSearchOptions = {},
): readonly TranscriptSearchMatch[] {
  const normalizedQuery = query.trim();
  const limit = Math.max(0, Math.floor(options.limit ?? 3));
  if (normalizedQuery.length === 0 || limit === 0) return [];

  const needle = options.caseSensitive ? normalizedQuery : normalizedQuery.toLocaleLowerCase();
  const matches: TranscriptSearchMatch[] = [];
  let turn = 0;

  for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
    const event = events[eventIndex]!;
    if (event.kind === 'turn' && event.state === 'started') {
      turn += 1;
      continue;
    }
    if (options.roles !== undefined && !options.roles.includes(event.role)) continue;
    const text = searchableText(event);
    if (text === undefined) continue;
    const haystack = options.caseSensitive ? text : text.toLocaleLowerCase();
    const at = haystack.indexOf(needle);
    if (at < 0) continue;

    matches.push({
      eventIndex,
      harness: event.harness,
      role: event.role,
      kind: event.kind,
      turn: Math.max(1, turn),
      snippet: snippetAround(text, at, needle.length),
      timestamp: event.timestamp,
    });
    if (matches.length >= limit) break;
  }
  return matches;
}
