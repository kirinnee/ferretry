import type { TranscriptEntry, TurnUsage } from '@ferretry/core-ferrets/contract';
import { instantFromEpochMs, type JsonValue } from '@ferretry/std';
import { z } from 'zod';

const count = z.number().finite().nonnegative();
const timestamp = count.max(8_640_000_000_000_000);
const tokens = z.object({
  input: count,
  output: count,
  reasoning: count,
  cache: z.object({ read: count, write: count }),
});
const model = z.object({ id: z.string(), providerID: z.string() });
const time = z.object({ created: timestamp, completed: timestamp.optional() });
const text = z.object({ type: z.literal('text'), text: z.string() });
const tool = z.object({
  type: z.literal('tool'),
  id: z.string().min(1),
  name: z.string(),
  state: z.object({
    status: z.string(),
    input: z.json().optional(),
    output: z.json().optional(),
    content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
    error: z.object({ type: z.string(), message: z.string() }).optional(),
  }),
});
const message = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user'), id: z.string().min(1), time, text: z.string() }),
  z.object({
    type: z.literal('assistant'),
    id: z.string().min(1),
    time,
    model,
    content: z.array(
      z.discriminatedUnion('type', [text, tool, z.object({ type: z.literal('reasoning'), text: z.string() })]),
    ),
    tokens,
    cost: count,
  }),
  z.object({ type: z.literal('idle'), id: z.string().min(1), time, outcome: z.string() }),
]);
const schema = z.object({
  info: z.object({
    id: z.string(),
    tokens,
    cost: count,
    model,
    time: time.extend({ updated: timestamp.optional() }),
    title: z.string().optional(),
    location: z.object({ directory: z.string() }),
  }),
  messages: z.array(message),
});
export type SessionExport = z.infer<typeof schema>;

/** The raw export is private evidence; schema errors deliberately never quote any of its values. */
export function decodeExport(raw: unknown, session: string): SessionExport {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error('OpenCode export is not a supported V2 session snapshot');
  if (parsed.data.info.id !== session) throw new Error('OpenCode exported another session');
  const ids = parsed.data.messages.map(entry => entry.id);
  if (new Set(ids).size !== ids.length) throw new Error('OpenCode export has duplicate message IDs');
  return parsed.data;
}

/** Completed records only: a streaming assistant's growing text must not be emitted once and then lost. */
export function exportEntries(snapshot: SessionExport): readonly TranscriptEntry[] {
  return snapshot.messages.flatMap((entry): TranscriptEntry[] => {
    const at = instantFromEpochMs(entry.time.created);
    if (entry.type === 'user') return [{ id: entry.id, role: 'user', at, text: entry.text }];
    if (entry.type === 'idle') return [{ id: entry.id, role: 'system', at, data: { outcome: entry.outcome } }];
    if (entry.time.completed === undefined) return [];
    const calls = entry.content.filter(part => part.type === 'tool');
    const entries: TranscriptEntry[] = [
      {
        id: entry.id,
        at,
        role: 'assistant',
        text: entry.content.flatMap(part => (part.type === 'text' ? [part.text] : [])).join('\n'),
        ...(calls.length === 0 ? {} : { tools: { calls: calls.map(part => part.id) } }),
      },
    ];
    for (const part of calls) {
      const state = part.state;
      if (state.status !== 'completed' && state.status !== 'error') continue;
      const output =
        state.error?.message ??
        state.content
          ?.flatMap(item => (item.type === 'text' && item.text !== undefined ? [item.text] : []))
          .join('\n') ??
        (typeof state.output === 'string' ? state.output : '');
      entries.push({
        id: `${entry.id}:tool:${part.id}`,
        at,
        role: 'tool',
        text: output,
        tools: { results: [part.id] },
        data: {
          name: part.name,
          ...(state.input === undefined ? {} : { input: state.input }),
          ...(state.error === undefined ? {} : { error: state.error }),
        } as JsonValue,
      });
    }
    return entries;
  });
}

/** Session aggregates include background work. Keep them separate from visible call totals, never add both. */
export function exportUsage(snapshot: SessionExport): {
  readonly turns: readonly TurnUsage[];
  readonly visibleCost: number;
  readonly session: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly reasoningTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
    readonly cost: number;
  };
} {
  const assistants = snapshot.messages
    .filter(entry => entry.type === 'assistant')
    .filter(entry => entry.time.completed !== undefined);
  return {
    turns: assistants.map((entry, index) => ({
      turn: index + 1,
      at: instantFromEpochMs(entry.time.created),
      model: `${entry.model.providerID}/${entry.model.id}`,
      inputTokens: entry.tokens.input,
      outputTokens: entry.tokens.output,
      cacheReadTokens: entry.tokens.cache.read,
      cacheWriteTokens: entry.tokens.cache.write,
    })),
    visibleCost: assistants.reduce((total, entry) => total + entry.cost, 0),
    session: {
      inputTokens: snapshot.info.tokens.input,
      outputTokens: snapshot.info.tokens.output,
      reasoningTokens: snapshot.info.tokens.reasoning,
      cacheReadTokens: snapshot.info.tokens.cache.read,
      cacheWriteTokens: snapshot.info.tokens.cache.write,
      cost: snapshot.info.cost,
    },
  };
}
