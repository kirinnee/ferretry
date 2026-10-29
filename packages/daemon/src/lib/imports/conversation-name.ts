import { CONVERSATION_NAME_MAX } from '@ferretry/protocol/conversation-import';
import type { Harness } from '@ferretry/protocol/session-base';
import { truncateText } from './conversation-text.ts';

/**
 * The NAME a CLI gave a conversation, read out of its transcript with no parser: a name is a record
 * of its own that no message event carries.
 *
 *   Claude Code  `{"type":"custom-title","customTitle":…}` (and `agent-name`) is what the owner typed with
 *                `/rename`; `{"type":"ai-title","aiTitle":…}` and `{"type":"summary","summary":…}` are the
 *                titles it generated. The owner's own name outranks a generated one; within a kind, the
 *                latest record wins.
 *   Codex        `{"type":"event_msg","payload":{"type":"thread_name_updated","thread_name":…}}`, latest
 *                wins. (`session_index.jsonl` holds the same names; see {@link codexIndexNames}.)
 */

const collapse = (text: string): string => text.replace(/\s+/gu, ' ').trim();

/** A record's name, cleaned and cut, or `undefined` when it is not a usable string. */
const cleaned = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const name = collapse(value);
  return name === '' ? undefined : truncateText(name, CONVERSATION_NAME_MAX);
};

const records = function* (text: string): Generator<Record<string, unknown>> {
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof value === 'object' && value !== null) yield value as Record<string, unknown>;
  }
};

/** The names a transcript records, by who gave them: the owner (`chosen`), or the CLI (`generated`). */
export interface TranscriptNames {
  readonly chosen?: string;
  readonly generated?: string;
}

/** What the transcript calls itself: the owner's name, else the CLI's, the latest of each. */
export function transcriptName(harness: Harness, text: string): string | undefined {
  const { chosen, generated } = transcriptNames(harness, text);
  return chosen ?? generated;
}

/** Each kind of name a transcript records, the latest of each. */
export function transcriptNames(harness: Harness, text: string): TranscriptNames {
  let chosen: string | undefined;
  let generated: string | undefined;
  for (const record of records(text)) {
    if (harness === 'codex') {
      const payload = record.payload;
      if (
        record.type === 'event_msg' &&
        typeof payload === 'object' &&
        payload !== null &&
        (payload as Record<string, unknown>).type === 'thread_name_updated'
      )
        chosen = cleaned((payload as Record<string, unknown>).thread_name) ?? chosen;
      continue;
    }
    if (record.type === 'custom-title') chosen = cleaned(record.customTitle) ?? chosen;
    else if (record.type === 'agent-name') chosen = cleaned(record.agentName) ?? chosen;
    else if (record.type === 'ai-title') generated = cleaned(record.aiTitle) ?? generated;
    else if (record.type === 'summary') generated = cleaned(record.summary) ?? generated;
  }
  return { ...(chosen === undefined ? {} : { chosen }), ...(generated === undefined ? {} : { generated }) };
}

/** Codex's `session_index.jsonl`: each line `{id, thread_name, updated_at}`; the latest line per id wins. */
export function codexIndexNames(text: string): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const record of records(text)) {
    const name = cleaned(record.thread_name);
    if (typeof record.id === 'string' && name !== undefined) names.set(record.id, name);
  }
  return names;
}
