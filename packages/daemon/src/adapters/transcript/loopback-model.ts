/**
 * A model endpoint on 127.0.0.1 that answers "OK" to anything, and remembers what it was asked.
 *
 * It speaks just enough of the two wire protocols the harnesses use — Anthropic's Messages API
 * (streamed) for Claude Code, and OpenAI's Responses API (streamed) for Codex — for a CLI to finish
 * one turn. It never runs a tool and never says anything but "OK", so the CLI it serves does nothing
 * but read its own conversation and send it here. That request is the evidence a conversion check
 * reads: the history the CLI reconstructed from the file, exactly as it would send it to a real model.
 */

/** One request body the endpoint received, parsed. */
export type RecordedRequest = Readonly<Record<string, unknown>>;

const REPLY = 'OK';

const sse = (events: readonly (readonly [string, unknown])[]): Response =>
  new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });

function anthropicReply(model: unknown, serial: number): Response {
  const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  return sse([
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: `msg_fy_check_${serial}`,
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          usage,
        },
      },
    ],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: REPLY } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }],
  ]);
}

function responsesReply(serial: number): Response {
  const id = `resp_fy_check_${serial}`;
  const item = {
    type: 'message',
    role: 'assistant',
    id: `msg_${id}`,
    content: [{ type: 'output_text', text: REPLY, annotations: [] }],
  };
  return sse([
    ['response.created', { type: 'response.created', response: { id } }],
    ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item }],
    ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item }],
    [
      'response.completed',
      {
        type: 'response.completed',
        response: {
          id,
          output: [item],
          usage: {
            input_tokens: 1,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 1,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 2,
          },
        },
      },
    ],
  ]);
}

export class LoopbackModel {
  private server: ReturnType<typeof Bun.serve> | undefined;
  private readonly received: RecordedRequest[] = [];

  /** The model requests received so far, oldest first. Token-count and other side calls are not kept. */
  get requests(): readonly RecordedRequest[] {
    return this.received;
  }

  /** Starts listening on an ephemeral loopback port and answers with it. */
  start(): number {
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async request => {
        const path = new URL(request.url).pathname;
        const body = (await request.json().catch(() => ({}))) as RecordedRequest;
        if (path.endsWith('/messages')) {
          this.received.push(body);
          return anthropicReply(body.model, this.received.length);
        }
        if (path.endsWith('/responses')) {
          this.received.push(body);
          return responsesReply(this.received.length);
        }
        // Model listings, token counts, feature probes: an empty success, so nothing waits on them.
        return Response.json({ data: [], models: [] });
      },
    });
    this.server = server;
    return server.port as number;
  }

  stop(): void {
    void this.server?.stop(true);
    this.server = undefined;
  }
}

const object = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

/** Every text a content value holds, flattened: strings, `text` blocks, and tool results' text. */
function contentTexts(value: unknown): readonly string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(contentTexts);
  const block = object(value);
  if (block === undefined) return [];
  if (typeof block.text === 'string') return [block.text];
  if (typeof block.output === 'string') return [block.output];
  return contentTexts(block.content);
}

/** The conversation a recorded request carried, as one text in order: Messages or Responses. */
export function requestTexts(request: RecordedRequest): string {
  const turns = Array.isArray(request.messages) ? request.messages : Array.isArray(request.input) ? request.input : [];
  return turns
    .flatMap(turn => {
      const item = object(turn);
      return item === undefined ? [] : contentTexts(item.content ?? item.output);
    })
    .join('\n');
}

/** The tool names a recorded request declared. */
export function requestToolNames(request: RecordedRequest): ReadonlySet<string> {
  const tools = Array.isArray(request.tools) ? request.tools : [];
  return new Set(
    tools.flatMap(tool => {
      const name = object(tool)?.name;
      return typeof name === 'string' ? [name] : [];
    }),
  );
}
