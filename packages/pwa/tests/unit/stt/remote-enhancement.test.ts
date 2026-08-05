import { describe, it } from 'bun:test';
import { MAX_STT_DICTIONARY_ENTRIES, SttEnhancementRequestSchema } from '@ferretry/protocol';
import should from 'should';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { MAX_DICTIONARY_TERMS } from '../../../src/lib/stt/enhancement.ts';
import {
  MAX_REMOTE_ENHANCEMENT_TEXT_CHARS,
  REMOTE_ENHANCEMENT_TIMEOUT_MS,
  RemoteEnhancementError,
  type RemoteEnhancementFetch,
  type RemoteEnhancementInput,
  requestRemoteEnhancement,
  STT_ENHANCE_PATH,
} from '../../../src/lib/stt/remote-enhancement.ts';

const alpha = daemonConnection({
  daemonId: 'daemon-alpha',
  baseUrl: 'https://alpha.example.test',
  deviceToken: 'token-alpha',
});
const beta = daemonConnection({
  daemonId: 'daemon-beta',
  baseUrl: 'https://beta.example.test',
  deviceToken: 'token-beta',
});

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

const recorder = (
  respond: (call: Call) => Response | Promise<Response>,
): { readonly calls: Call[]; readonly fetchImpl: RemoteEnhancementFetch } => {
  const calls: Call[] = [];
  const fetchImpl: RemoteEnhancementFetch = async (url, init) => {
    calls.push({ url, init });
    return respond({ url, init });
  };
  return { calls, fetchImpl };
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const unreadable = (status = 200): Response => new Response('<html>', { status });

const ask = (overrides: Partial<RemoteEnhancementInput> = {}): RemoteEnhancementInput => ({
  provider: 'groq',
  model: 'llama-3.1-8b-instant',
  text: 'run kteem now',
  dictionary: [],
  context: [],
  userContext: '',
  ...overrides,
});

const rejection = async (promise: Promise<unknown>): Promise<RemoteEnhancementError> => {
  try {
    await promise;
  } catch (error) {
    return error as RemoteEnhancementError;
  }
  throw new Error('the request resolved when it should have refused');
};

describe('requestRemoteEnhancement', () => {
  it('posts the transcript to the paired daemon with that daemon’s token', async () => {
    const { calls, fetchImpl } = recorder(() => json({ text: 'run kteam now', provider: 'groq', latencyMs: 12 }));
    const result = await requestRemoteEnhancement(alpha, ask({ fetchImpl }));

    should(result.text).equal('run kteam now');
    should(result.provider).equal('groq');
    should(result.latencyMs).equal(12);

    const call = calls[0] as Call;
    should(call.url).equal(`https://alpha.example.test${STT_ENHANCE_PATH}`);
    should(new Headers(call.init.headers).get('authorization')).equal('Bearer token-alpha');
    should(new Headers(call.init.headers).get('content-type')).equal('application/json');
  });

  it('never posts dictated text to a daemon the reader did not choose', async () => {
    const { calls, fetchImpl } = recorder(() => json({ text: 'ok' }));
    await requestRemoteEnhancement(beta, ask({ fetchImpl }));

    should(calls[0]?.url).startWith('https://beta.example.test');
    should(new Headers((calls[0] as Call).init.headers).get('authorization')).equal('Bearer token-beta');
  });

  it('sends the vocabulary but never a credential', async () => {
    const { calls, fetchImpl } = recorder(() => json({ text: 'ok' }));
    await requestRemoteEnhancement(
      alpha,
      ask({ fetchImpl, dictionary: [{ term: 'kteam', aliases: ['kteem'] }], userContext: 'jargon' }),
    );

    const body = JSON.parse((calls[0] as Call).init.body as string) as Record<string, unknown>;
    should(body).have.property('userContext', 'jargon');
    should(body.dictionary).deepEqual([{ term: 'kteam', aliases: ['kteem'] }]);
    should(Object.keys(body)).not.containEql('apiKey');
    should(Object.keys(body)).not.containEql('token');
  });

  it('sends a large local dictionary as the first entries this wire accepts, and succeeds', async () => {
    const { calls, fetchImpl } = recorder(() => json({ text: 'run kteam now' }));
    // A reader is allowed a bigger vocabulary than the wire takes: the local
    // deterministic enhancer uses all of it. Sending all of it would make the
    // daemon refuse the WHOLE request, so every correction would be lost.
    should(MAX_DICTIONARY_TERMS).be.above(MAX_STT_DICTIONARY_ENTRIES);
    const dictionary = Array.from({ length: MAX_DICTIONARY_TERMS }, (_unused, index) => ({
      term: `term-${index}`,
      aliases: [],
    }));

    const result = await requestRemoteEnhancement(alpha, ask({ fetchImpl, dictionary }));

    should(result.text).equal('run kteam now');
    const body = JSON.parse((calls[0] as Call).init.body as string) as { dictionary: { term: string }[] };
    should(body.dictionary).have.length(MAX_STT_DICTIONARY_ENTRIES);
    should(body.dictionary[0]?.term).equal('term-0');
    should(body.dictionary[MAX_STT_DICTIONARY_ENTRIES - 1]?.term).equal(`term-${MAX_STT_DICTIONARY_ENTRIES - 1}`);
    // The proof that matters: the daemon parses what was sent with THIS schema.
    should(SttEnhancementRequestSchema.safeParse(body).success).be.true();
  });

  it('does not open a request for text there is nothing to enhance in', async () => {
    const { calls, fetchImpl } = recorder(() => json({ text: 'ok' }));
    should((await requestRemoteEnhancement(alpha, ask({ text: '   ', fetchImpl }))).text).equal('   ');
    should(calls).have.length(0);
  });

  it('refuses a transcript longer than the provider will take', async () => {
    const failure = await rejection(
      requestRemoteEnhancement(alpha, ask({ text: 'x'.repeat(MAX_REMOTE_ENHANCEMENT_TEXT_CHARS + 1) })),
    );
    should(failure.code).equal('invalid-response');
  });

  it('refuses before opening a request when the caller has already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const { calls, fetchImpl } = recorder(() => json({ text: 'ok' }));

    should(
      (await rejection(requestRemoteEnhancement(alpha, ask({ signal: controller.signal, fetchImpl })))).code,
    ).equal('aborted');
    should(calls).have.length(0);
  });

  it('reports a cancel that lands mid-flight as aborted, not as a network failure', async () => {
    const controller = new AbortController();
    const failure = await rejection(
      requestRemoteEnhancement(
        alpha,
        ask({
          signal: controller.signal,
          fetchImpl: async () => {
            controller.abort();
            throw new Error('aborted');
          },
        }),
      ),
    );
    should(failure.code).equal('aborted');
  });

  it('gives up on its own clock and keeps the raw dictation', async () => {
    const failure = await rejection(
      requestRemoteEnhancement(
        alpha,
        ask({
          timeoutMs: 1,
          fetchImpl: (_url, init) =>
            new Promise((_resolve, reject) => {
              init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
            }),
        }),
      ),
    );
    should(failure.code).equal('timeout');
    should(failure.message).match(/raw dictation was kept/u);
  });

  it('reports an unreachable daemon', async () => {
    const failure = await rejection(
      requestRemoteEnhancement(
        alpha,
        ask({
          fetchImpl: async () => {
            throw new Error('offline');
          },
        }),
      ),
    );
    should(failure.code).equal('network');
  });

  it('maps the daemon’s own code onto something the UI can branch on', async () => {
    const cases: readonly [string, number, string][] = [
      ['secret_missing', 500, 'not-configured'],
      ['secret_invalid', 500, 'provider-auth'],
      ['rate_limited', 500, 'rate-limit'],
      ['bad_request', 500, 'bad-request'],
      ['provider_unknown', 500, 'bad-request'],
      ['too_long', 500, 'too-long'],
      ['bad_model', 500, 'bad-model'],
      ['timeout', 500, 'timeout'],
      ['provider_unreachable', 500, 'provider-unreachable'],
      ['malformed_response', 500, 'invalid-response'],
    ];

    for (const [code, status, expected] of cases) {
      const { fetchImpl } = recorder(() => json({ code }, status));
      should((await rejection(requestRemoteEnhancement(alpha, ask({ fetchImpl })))).code).equal(expected);
    }
  });

  it('falls back to the HTTP status when the body names no code', async () => {
    const statuses: readonly [number, string][] = [
      [401, 'unauthorized'],
      [403, 'unauthorized'],
      [404, 'unavailable'],
      [429, 'rate-limit'],
      [500, 'provider'],
    ];

    for (const [status, expected] of statuses) {
      const { fetchImpl } = recorder(() => json({}, status));
      should((await rejection(requestRemoteEnhancement(alpha, ask({ fetchImpl })))).code).equal(expected);
    }
  });

  it('says what a daemon too old to enhance actually means', async () => {
    const { fetchImpl } = recorder(() => json({}, 404));
    const failure = await rejection(requestRemoteEnhancement(alpha, ask({ fetchImpl })));
    should(failure.message).match(/does not support remote enhancement yet/u);
  });

  it('passes the daemon’s message through, bounded', async () => {
    const { fetchImpl } = recorder(() => json({ error: `  ${'m'.repeat(900)}  ` }, 500));
    should((await rejection(requestRemoteEnhancement(alpha, ask({ fetchImpl })))).message).have.length(400);
  });

  it('refuses an unreadable body, whether the response was ok or not', async () => {
    const ok = recorder(() => unreadable(200));
    should((await rejection(requestRemoteEnhancement(alpha, ask({ fetchImpl: ok.fetchImpl })))).code).equal(
      'invalid-response',
    );

    const bad = recorder(() => unreadable(429));
    should((await rejection(requestRemoteEnhancement(alpha, ask({ fetchImpl: bad.fetchImpl })))).code).equal(
      'rate-limit',
    );
  });

  it('prefers the timeout over an unreadable body that the timeout caused', async () => {
    const failure = await rejection(
      requestRemoteEnhancement(
        alpha,
        ask({
          timeoutMs: 1,
          fetchImpl: async (_url, init) =>
            new Promise(resolve => {
              init.signal?.addEventListener('abort', () => resolve(unreadable(200)));
            }),
        }),
      ),
    );
    should(failure.code).equal('timeout');
  });

  it('refuses a reply with no usable text rather than blanking the draft', async () => {
    for (const body of [{ text: '   ' }, { text: 'x'.repeat(MAX_REMOTE_ENHANCEMENT_TEXT_CHARS + 1) }, {}]) {
      const { fetchImpl } = recorder(() => json(body));
      should((await rejection(requestRemoteEnhancement(alpha, ask({ fetchImpl })))).code).equal('invalid-response');
    }
  });

  it('omits the optional fields the provider did not report', async () => {
    const { fetchImpl } = recorder(() => json({ text: 'ok', latencyMs: Number.POSITIVE_INFINITY, model: 7 }));
    const result = await requestRemoteEnhancement(alpha, ask({ fetchImpl }));

    should(result.provider).be.undefined();
    should(result.model).be.undefined();
    should(result.latencyMs).be.undefined();
  });

  it('has a default deadline so a hung provider cannot hold the draft', () => {
    should(REMOTE_ENHANCEMENT_TIMEOUT_MS).be.below(5_000);
  });
});
