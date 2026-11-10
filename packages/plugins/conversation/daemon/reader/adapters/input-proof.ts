import type { TranscriptEntry } from '@ferretry/core-ferrets/contract';
import { ClaudeObservedInputObserver, CodexObservedInputObserver } from '../lib/transcript/observed-input.ts';
import type { ObservedHumanInput, TranscriptHarness, TranscriptInputObserver } from '../lib/transcript/types.ts';

/**
 * WHAT A HARNESS PLUGIN'S ENTRY SAYS OF AN INPUT, read back into the record today's observers know (#45, the send
 * tracker's proof).
 *
 * The harness plugins hand Conversation `TranscriptEntry`s, not file records, so the matching rules of today's
 * `ClaudeObservedInputObserver` / `CodexObservedInputObserver` (v4's, unchanged and tested where they are) are fed the
 * record an entry stands for: a user entry is a user record, and Claude's two input-queue records travel as entries
 * whose `data.proof` is one of the two words below (the Claude plugin writes them; this is the other end of that
 * convention, with no contract change: `data` is the entry's own field). The text is the entry's, already masked
 * when it left the harness's reader, so a message that held a secret reads masked here and on the other side alike.
 */
const QUEUE_OPERATION_PROOF = 'queue-operation';
const QUEUED_PROMPT_PROOF = 'queued-prompt';

const objectOf = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

/** Whether the entry is a harness queue record: input evidence, never a message anybody wrote or read. */
export function isInputProofEntry(entry: TranscriptEntry): boolean {
  const proof = objectOf(entry.data)?.proof;
  return proof === QUEUE_OPERATION_PROOF || proof === QUEUED_PROMPT_PROOF;
}

/** The record the entry stands for in the harness's own file, or nothing when it is no input at all. */
function recordOf(harness: TranscriptHarness, entry: TranscriptEntry): unknown {
  const text = entry.text;
  if (text === undefined) return undefined;
  const data = objectOf(entry.data);
  if (data?.proof === QUEUE_OPERATION_PROOF)
    return { type: 'queue-operation', operation: data.operation, timestamp: entry.at, content: text };
  if (data?.proof === QUEUED_PROMPT_PROOF)
    return {
      type: 'attachment',
      uuid: entry.id,
      timestamp: entry.at,
      attachment: {
        type: 'queued_command',
        commandMode: 'prompt',
        prompt: text,
        origin: { kind: 'human' },
        ...(typeof data.originatedAt === 'string' ? { timestamp: data.originatedAt } : {}),
      },
    };
  if (entry.role !== 'user') return undefined;
  return harness === 'claude'
    ? { type: 'user', uuid: entry.id, timestamp: entry.at, message: { role: 'user', content: text } }
    : {
        type: 'response_item',
        timestamp: entry.at,
        payload: { type: 'message', id: entry.id, role: 'user', content: [{ type: 'input_text', text }] },
      };
}

/** A fresh observer for a harness: it keeps the little state (Claude's removed-prompt ring) the matching needs. */
export function inputObserverFor(harness: TranscriptHarness): TranscriptInputObserver {
  return harness === 'claude' ? new ClaudeObservedInputObserver() : new CodexObservedInputObserver();
}

/**
 * The human inputs one entry proves, through the harness's own observer. `ordinal` is the entry's place in the stream, which
 * names a proof that carries no id of its own. Feed entries in order: the observer remembers the prompts Claude removed.
 */
export function observedInputsOf(
  observer: TranscriptInputObserver,
  entry: TranscriptEntry,
  ordinal: number,
): readonly ObservedHumanInput[] {
  const record = recordOf(observer.harness, entry);
  if (record === undefined) return [];
  return observer.observe(record, {
    source: observer.harness,
    byteOffset: ordinal,
    byteLength: 1,
    observedAt: entry.at,
  });
}
