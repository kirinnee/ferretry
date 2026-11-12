/** The one reply every fake provider answers with: a test looks for it in the pane the daemon reports. */
export const FAKE_REPLY = 'FAKE-PROVIDER-REPLY-OK';

/** What the fake provider saw of one request. Names and a verdict only: the token's value is never recorded. */
interface SeenRequest {
  readonly method: string;
  readonly path: string;
  /** Which auth header carried something: `authorization` (a Bearer) and/or `x-api-key`. */
  readonly authHeaders: readonly string[];
  /** Whether the value (after `Bearer `) equals the one fake token this provider was given. */
  readonly tokenMatches: boolean;
}

export interface FakeProvider {
  readonly url: string;
  readonly seen: SeenRequest[];
  stop(): void;
}

const anthropicMessage = (text: string) => ({
  id: 'msg_fake',
  type: 'message',
  role: 'assistant',
  model: 'fake-model',
  content: [{ type: 'text', text }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 1, output_tokens: 1 },
});

const openAiResponse = (text: string) => ({
  id: 'resp_fake',
  object: 'response',
  status: 'completed',
  model: 'fake-model',
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
});

/**
 * A loopback provider speaking the Anthropic Messages shape (`POST /v1/messages`) and the OpenAI Responses shape
 * (`POST /v1/responses`) with one fixed reply. Port 0, so the operating system picks; fake values only.
 */
export function startFakeProvider(expectedToken: string): FakeProvider {
  const seen: SeenRequest[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      const bearer = request.headers.get('authorization');
      const apiKey = request.headers.get('x-api-key');
      const authHeaders = [bearer === null ? '' : 'authorization', apiKey === null ? '' : 'x-api-key'].filter(
        name => name !== '',
      );
      const presented = bearer?.replace(/^Bearer /u, '') ?? apiKey;
      seen.push({ method: request.method, path, authHeaders, tokenMatches: presented === expectedToken });
      if (path === '/v1/messages') return Response.json(anthropicMessage(FAKE_REPLY));
      if (path === '/v1/responses') return Response.json(openAiResponse(FAKE_REPLY));
      return Response.json({});
    },
  });
  return { url: `http://127.0.0.1:${String(server.port)}`, seen, stop: () => void server.stop(true) };
}
