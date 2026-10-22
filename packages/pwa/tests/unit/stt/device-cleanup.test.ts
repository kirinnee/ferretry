/**
 * Dictation clean-up straight from the browser with a key this device holds. The provider is a fake
 * behind the vault's network port: it records what the browser sent and answers as Groq or Cerebras
 * would, so every outcome — cleaned, kept raw, each HTTP failure, the retry without the conversation,
 * the deadline — is driven with no network at all.
 */

import { describe, it } from 'bun:test';
import { CLEANUP_GUARD, CLEANUP_LIMITS, CLEANUP_VIOLATION_REASONS } from '@ferretry/protocol';
import should from 'should';
import {
  DEVICE_KEYS_PLACE,
  type DeviceCleanupInput,
  deviceCleanupStatusError,
  requestDeviceCleanup,
  testDeviceKey,
} from '../../../src/lib/stt/device-cleanup.ts';
import { RemoteEnhancementError, type RemoteEnhancementResult } from '../../../src/lib/stt/remote-enhancement.ts';
import { DeviceSpeedupKeys, type SpeedupKeyRecords } from '../../../src/lib/stt/speedup-keys.ts';
import { DEFAULT_VOICE_CLEANUP } from '../../../src/lib/stt/voice-cleanup.ts';

class MemoryRecords implements SpeedupKeyRecords {
  readonly values = new Map<string, unknown>();
  async get(slot: string): Promise<unknown> {
    return this.values.get(slot);
  }
  async put(slot: string, value: unknown): Promise<void> {
    this.values.set(slot, value);
  }
  async delete(slot: string): Promise<void> {
    this.values.delete(slot);
  }
}

interface Call {
  readonly url: string;
  readonly body: Record<string, unknown> | undefined;
}

type Answer = (call: Call, signal: AbortSignal | undefined) => Response | Promise<Response>;

/** A fake provider: each call takes the next scripted answer, or the last one again. */
const provider = async (answers: readonly Answer[], options: { readonly key?: boolean } = {}) => {
  const records = new MemoryRecords();
  const calls: Call[] = [];
  const keys = new DeviceSpeedupKeys(records, crypto.subtle, async (url, init) => {
    const call: Call = {
      url: String(url),
      body: init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as Record<string, unknown>),
    };
    calls.push(call);
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (answer === undefined) throw new Error('no answer scripted');
    return await answer(call, init?.signal ?? undefined);
  });
  if (options.key !== false) {
    await keys.save('groq', 'gsk_test_0123456789abcdef');
    await keys.save('cerebras', 'csk-test-0123456789abcdef');
  }
  return { keys, calls, records };
};

const reply =
  (content: unknown, finish = 'stop'): Answer =>
  () =>
    Response.json({ choices: [{ message: { content }, finish_reason: finish }] });
const status =
  (code: number, headers: Record<string, string> = {}): Answer =>
  () =>
    new Response('{"error":{"message":"the provider body is never read"}}', { status: code, headers });

/** Never answers; rejects the way fetch does — at once if the signal is already aborted, else when it aborts. */
const hang: Answer = (_call, signal) =>
  new Promise((_resolve, reject) => {
    const aborted = (): void => reject(new DOMException('aborted', 'AbortError'));
    if (signal?.aborted === true) return aborted();
    signal?.addEventListener('abort', aborted, { once: true });
  });

const input = (patch: Partial<DeviceCleanupInput> = {}): DeviceCleanupInput => ({
  provider: 'groq',
  model: 'openai/gpt-oss-120b',
  text: 'hello wold this is the dictation',
  dictionary: [],
  context: [],
  userContext: '',
  cleanup: DEFAULT_VOICE_CLEANUP,
  ...patch,
});

const rejection = async (work: Promise<unknown>): Promise<RemoteEnhancementError> => {
  const outcome = await work.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  should(outcome).be.instanceof(RemoteEnhancementError);
  return outcome as RemoteEnhancementError;
};

/** The result as a caller reads it, leaving out how long the call took, which has its own tests. */
const withoutTiming = (result: RemoteEnhancementResult | undefined) => {
  if (result === undefined) return undefined;
  const { timing: _timing, ...rest } = result;
  return rest;
};

/** A monotonic clock that moves `step` ms every time it is read. */
const ticking = (step: number) => {
  let at = 0;
  return () => {
    const read = at;
    at += step;
    return read;
  };
};

const userMessage = (call: Call | undefined): string =>
  String((call?.body?.messages as { content: string }[] | undefined)?.[1]?.content ?? '');

describe('clean-up with a key this device holds', () => {
  it('should send the shared, guarded request straight to the provider and use the correction', async () => {
    // Arrange
    const { keys, calls } = await provider([reply('<think>fix it</think>Hello world, this is the dictation.')]);

    // Act
    const result = await requestDeviceCleanup(
      keys,
      input({ dictionary: [{ term: 'Ferretry', aliases: ['ferry tree'] }], userContext: 'jargon' }),
    );

    // Assert
    should(withoutTiming(result)).eql({
      text: 'Hello world, this is the dictation.',
      provider: 'groq',
      model: 'openai/gpt-oss-120b',
    });
    should(calls).have.length(1);
    should(calls[0]?.url).equal('https://api.groq.com/openai/v1/chat/completions');
    should(calls[0]?.body).containDeep({
      model: 'openai/gpt-oss-120b',
      reasoning_effort: 'low',
      include_reasoning: false,
    });
    should(String((calls[0]?.body?.messages as { content: string }[] | undefined)?.[0]?.content)).startWith(
      CLEANUP_GUARD,
    );
    should(userMessage(calls[0])).containEql('ferry tree -> Ferretry');
    should(userMessage(calls[0])).containEql('<hints>\njargon\n</hints>');
  });

  it('should send the conversation only as far as the machine allows it', async () => {
    // Arrange
    const { keys, calls } = await provider([reply('Hello world this is the dictation.')]);
    const context = ['the oldest earlier message in this session', 'the newest earlier message in this session'];

    // Act
    await requestDeviceCleanup(keys, input({ context }));
    await requestDeviceCleanup(
      keys,
      input({ context, cleanup: { ...DEFAULT_VOICE_CLEANUP, useConversation: true, conversationMessages: 1 } }),
    );

    // Assert
    should(userMessage(calls[0])).not.containEql('<reference>');
    should(userMessage(calls[1])).containEql('<reference>\nthe newest earlier message in this session\n</reference>');
  });

  it('should keep the raw words with the guard’s reason when the reply is not the dictation', async () => {
    // Arrange
    const { keys } = await provider([reply('Sure! Here is a long answer about many unrelated things. '.repeat(5))]);

    // Act
    const result = await requestDeviceCleanup(keys, input({ provider: 'cerebras', model: 'gpt-oss-120b' }));

    // Assert
    should(withoutTiming(result)).eql({
      text: 'hello wold this is the dictation',
      provider: 'cerebras',
      model: 'gpt-oss-120b',
      kept: 'raw',
      keptReason: CLEANUP_VIOLATION_REASONS.too_long,
    });
  });

  it('should answer nothing at all when this device holds no key, so the caller asks the daemon', async () => {
    // Arrange
    const { keys, calls } = await provider([reply('x')], { key: false });

    // Assert
    should(await requestDeviceCleanup(keys, input())).be.undefined();
    should(calls).have.length(0);
  });

  it('should say the saved key can no longer be read, and where to fix it', async () => {
    // Arrange
    const { keys, records, calls } = await provider([reply('x')]);
    records.values.delete('wrapping-key');

    // Act
    const failure = await rejection(requestDeviceCleanup(keys, input()));

    // Assert
    should(failure.code).equal('provider-auth');
    should(failure.message).containEql(DEVICE_KEYS_PLACE);
    should(calls).have.length(0);
  });

  it('should send nothing for an empty take, for clean-up switched off, or a model id it will not send', async () => {
    // Arrange
    const { keys, calls } = await provider([reply('x')]);

    // Assert
    should(await requestDeviceCleanup(keys, input({ text: '   ' }))).eql({ text: '   ' });
    should(await requestDeviceCleanup(keys, input({ cleanup: { ...DEFAULT_VOICE_CLEANUP, style: 'off' } }))).eql({
      text: 'hello wold this is the dictation',
    });
    should((await rejection(requestDeviceCleanup(keys, input({ model: 'not a model!' })))).code).equal('bad-model');
    should(calls).have.length(0);
  });

  it('should refuse at once when the take was already cancelled', async () => {
    // Arrange
    const { keys, calls } = await provider([reply('x')]);
    const controller = new AbortController();
    controller.abort();

    // Assert
    should((await rejection(requestDeviceCleanup(keys, input({ signal: controller.signal })))).code).equal('aborted');
    should(calls).have.length(0);
  });
});

describe('every way the provider can fail', () => {
  it('should name the status and the next step, and never the provider’s body', async () => {
    // Assert
    const cases: [number, string, RegExp][] = [
      [401, 'provider-auth', /rejected the key saved on this device \(HTTP 401\); check it in Settings › This device/u],
      [403, 'provider-auth', /HTTP 403/u],
      [404, 'bad-model', /does not offer that model.*pick another model/u],
      [413, 'too-long', /too large for its limit \(HTTP 413\)/u],
      [429, 'rate-limit', /^Groq is rate limiting this key \(HTTP 429\)\.$/u],
      [503, 'provider', /^Groq returned an error \(HTTP 503\)\.$/u],
      [418, 'provider', /^Groq rejected the request \(HTTP 418\)\.$/u],
    ];
    for (const [code, kind, message] of cases) {
      const { keys } = await provider([status(code)]);
      const failure = await rejection(requestDeviceCleanup(keys, input()));
      should(failure.code).equal(kind);
      should(failure.status).equal(code);
      should(failure.message).match(message);
      should(failure.message).not.containEql('never read');
    }
  });

  it('should say how long to wait when the provider says so', async () => {
    // Arrange
    const { keys } = await provider([status(429, { 'retry-after': '2.2' })]);

    // Assert
    should((await rejection(requestDeviceCleanup(keys, input()))).message).match(/try again in 3s\.$/u);
    should(deviceCleanupStatusError('cerebras', { status: 429, retryAfterSeconds: 0 }).message).match(
      /^Cerebras is rate limiting this key \(HTTP 429\); try again in 1s\.$/u,
    );
  });

  it('should retry once without the conversation when the provider finds the request too big', async () => {
    // Arrange
    const { keys, calls } = await provider([status(413), reply('Hello world this is the dictation.')]);
    const cleanup = { ...DEFAULT_VOICE_CLEANUP, useConversation: true };

    // Act
    const result = await requestDeviceCleanup(
      keys,
      input({ cleanup, context: ['an earlier message that is long enough to keep'] }),
    );

    // Assert
    should(result?.text).equal('Hello world this is the dictation.');
    should(calls).have.length(2);
    should(userMessage(calls[0])).containEql('<reference>');
    should(userMessage(calls[1])).not.containEql('<reference>');
  });

  it('should not retry when there was no conversation to drop, or the failure is another kind', async () => {
    // Arrange
    const tooBig = await provider([status(400)]);
    const denied = await provider([status(401)]);
    const cleanup = { ...DEFAULT_VOICE_CLEANUP, useConversation: true };
    const context = ['an earlier message that is long enough to keep'];

    // Act
    await rejection(requestDeviceCleanup(tooBig.keys, input()));
    await rejection(requestDeviceCleanup(denied.keys, input({ cleanup, context })));

    // Assert
    should(tooBig.calls).have.length(1);
    should(denied.calls).have.length(1);
  });

  it('should name an empty, cut-off, unreadable or oversized reply', async () => {
    // Assert
    const cases: [Answer, RegExp][] = [
      [reply(''), /empty reply/u],
      [reply('', 'length'), /whole reply budget/u],
      [() => new Response('not json', { status: 200 }), /unreadable response/u],
      [() => new Response(' '.repeat(CLEANUP_LIMITS.maxResponseBytes + 1), { status: 200 }), /unreadable response/u],
    ];
    for (const [answer, message] of cases) {
      const { keys } = await provider([answer]);
      const failure = await rejection(requestDeviceCleanup(keys, input()));
      should(failure.code).equal('invalid-response');
      should(failure.message).match(message);
    }
  });

  it('should say the provider could not be reached from this browser', async () => {
    // Arrange
    const { keys } = await provider([
      () => {
        throw new TypeError('Failed to fetch');
      },
    ]);

    // Act
    const failure = await rejection(requestDeviceCleanup(keys, input()));

    // Assert
    should(failure.code).equal('network');
    should(failure.message).match(/^Groq could not be reached from this browser/u);
  });

  it('should give up at the deadline, and on a cancel, and say which', async () => {
    // Arrange
    const slow = await provider([hang]);
    const cancelled = await provider([hang]);
    const controller = new AbortController();

    // Act
    const timeout = await rejection(requestDeviceCleanup(slow.keys, input({ timeoutMs: 5 })));
    const pending = rejection(requestDeviceCleanup(cancelled.keys, input({ signal: controller.signal })));
    await new Promise(resolve => setTimeout(resolve, 5));
    controller.abort();
    const abort = await pending;

    // Assert
    should(timeout.code).equal('timeout');
    should(timeout.message).match(/longer than 0\.005s/u);
    should(abort.code).equal('aborted');
  });
});

describe("a key's Test", () => {
  it('should list the models the key can use, for free', async () => {
    // Arrange
    const listed = await provider([() => Response.json({ data: [{ id: 'a' }, { id: 'b' }] })]);
    const odd = await provider([() => Response.json({ object: 'list' })]);

    // Assert
    should(await testDeviceKey(listed.keys, 'groq')).eql({ ok: true, models: 2 });
    should(listed.calls[0]?.url).equal('https://api.groq.com/openai/v1/models');
    should(listed.calls[0]?.body).be.undefined();
    should(await testDeviceKey(odd.keys, 'cerebras')).eql({ ok: true, models: 0 });
  });

  it('should say why a key does not work', async () => {
    // Arrange
    const none = await provider([status(200)], { key: false });
    const lost = await provider([status(200)]);
    lost.records.values.delete('wrapping-key');
    const denied = await provider([status(401)]);
    const down = await provider([
      () => {
        throw new TypeError('Failed to fetch');
      },
    ]);
    const slow = await provider([hang]);

    // Assert
    should(await testDeviceKey(none.keys, 'groq')).eql({ ok: false, message: 'No key is saved on this device.' });
    should((await testDeviceKey(lost.keys, 'groq')).ok).be.false();
    should(await testDeviceKey(denied.keys, 'groq')).containDeep({ ok: false });
    should(JSON.stringify(await testDeviceKey(denied.keys, 'groq'))).match(/HTTP 401/u);
    should(JSON.stringify(await testDeviceKey(down.keys, 'groq'))).match(/could not be reached/u);
    should(JSON.stringify(await testDeviceKey(slow.keys, 'groq', 5))).match(/did not answer within 0\.005s/u);
  });
});

describe('the debug record of a call', () => {
  const KEY = 'gsk_test_0123456789abcdef';

  /** A clock that moves 10 ms every time it is read, so timings are exact. */
  const ticking = (): (() => number) => {
    let at = 1_000;
    return () => {
      const now = at;
      at += 10;
      return now;
    };
  };

  const lastMessage = 'Hello world, this is the dictation.';

  it('should build nothing, and read no error body, unless asked', async () => {
    // Arrange
    const refused = new Response('provider body', { status: 429 });
    const failing = await provider([() => refused]);
    const working = await provider([reply(lastMessage)]);

    // Act
    const failure = await rejection(requestDeviceCleanup(failing.keys, input()));
    const result = await requestDeviceCleanup(working.keys, input());

    // Assert
    should(failure.trace).be.undefined();
    should(refused.bodyUsed).be.false();
    should(result?.trace).be.undefined();
  });

  it('should record the request as sent, the raw reply, the timings and the final text, never the key', async () => {
    // Arrange
    const { keys, calls } = await provider([reply(`<think>fix it</think>${lastMessage}`)]);

    // Act
    const result = await requestDeviceCleanup(keys, input({ debug: true, now: ticking() }));

    // Assert
    const trace = result?.trace;
    should(trace).be.ok();
    should(trace).containEql({
      via: 'device',
      provider: 'groq',
      model: 'openai/gpt-oss-120b',
      host: 'api.groq.com',
      outcome: 'cleaned',
      finalText: lastMessage,
      startedAt: 1_000,
    });
    const attempt = trace?.attempts[0];
    should(trace?.attempts).have.length(1);
    should(attempt?.request.headers).deepEqual({ authorization: '[redacted]', 'content-type': 'application/json' });
    should(attempt?.request.path).equal('/openai/v1/chat/completions');
    should(attempt?.request.messages).deepEqual(
      ((calls[0]?.body?.messages ?? []) as { role: 'system' | 'user'; content: string }[]).map(({ role, content }) => ({
        role,
        content,
      })),
    );
    should(attempt?.status).equal(200);
    should(attempt?.response?.verdict).equal('cleaned');
    should(attempt?.response?.steps.map(step => step.step)).deepEqual(['reasoning_stripped', 'guard_passed']);
    should(JSON.parse(attempt?.response?.raw ?? '{}')).have.property('choices');
    should(attempt?.timings).deepEqual({ startedAt: 1_010, firstByteMs: 10, totalMs: 20 });
    should(trace?.totalMs).be.above(0);
    should(JSON.stringify(trace)).not.containEql(KEY);
    should(JSON.stringify(trace)).not.containEql('Bearer');
  });

  it('should stamp the record from the wall clock when no clock is supplied', async () => {
    // Arrange
    const { keys } = await provider([reply(lastMessage)]);

    // Act
    const result = await requestDeviceCleanup(keys, input({ debug: true }));

    // Assert
    should(result?.trace?.startedAt).be.a.Number();
  });

  it('should record a reply the guard refused as kept raw', async () => {
    // Arrange
    const { keys } = await provider([reply('Sure! Here is a poem about something else entirely, in many lines.')]);

    // Act
    const result = await requestDeviceCleanup(keys, input({ debug: true }));

    // Assert
    should(result?.kept).equal('raw');
    should(result?.trace?.outcome).equal('kept_raw');
    should(result?.trace?.finalText).equal(input().text);
    should(result?.trace?.attempts[0]?.response?.steps.map(step => step.step)).deepEqual([
      'guard_rejected',
      'kept_raw',
    ]);
  });

  it('should record a provider failure on the error, with the status and the provider’s own words', async () => {
    // Arrange
    const { keys } = await provider([status(429)]);

    // Act
    const failure = await rejection(requestDeviceCleanup(keys, input({ debug: true })));

    // Assert
    should(failure.trace).containEql({ outcome: 'failed' });
    should(failure.trace?.failure?.code).equal('rate-limit');
    should(failure.trace?.finalText).be.undefined();
    should(failure.trace?.attempts[0]?.status).equal(429);
    should(failure.trace?.attempts[0]?.errorBody).containEql('the provider body is never read');
    should(failure.trace?.attempts[0]?.failure).equal(failure.message);
    should(JSON.stringify(failure.trace)).not.containEql(KEY);
  });

  it('should record both attempts when the request is sent again without the conversation', async () => {
    // Arrange
    const { keys } = await provider([status(413), reply(lastMessage)]);
    const cleanup = { ...DEFAULT_VOICE_CLEANUP, useConversation: true };

    // Act
    const result = await requestDeviceCleanup(
      keys,
      input({ cleanup, context: ['an earlier message that is long enough to keep'], debug: true }),
    );

    // Assert
    should(result?.trace?.attempts.map(item => item.withContext)).deepEqual([true, false]);
    should(result?.trace?.attempts[0]?.status).equal(413);
    should(result?.trace?.attempts[1]?.status).equal(200);
    should(result?.trace?.outcome).equal('cleaned');
  });

  it('should keep the body of a reply that was not JSON, and say nothing of one that cannot be read', async () => {
    // Arrange
    const garbled = await provider([() => new Response('<html>nope</html>', { status: 200 })]);
    const broken = await provider([
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error('cut'));
            },
          }),
          { status: 500 },
        ),
    ]);

    // Act
    const unreadable = await rejection(requestDeviceCleanup(garbled.keys, input({ debug: true })));
    const cut = await rejection(requestDeviceCleanup(broken.keys, input({ debug: true })));

    // Assert
    should(unreadable.trace?.attempts[0]?.errorBody).equal('<html>nope</html>');
    should(unreadable.trace?.attempts[0]?.response).be.undefined();
    should(cut.trace?.attempts[0]?.status).equal(500);
    should(cut.trace?.attempts[0]?.errorBody).be.undefined();
  });

  it('should record a call that never got an answer, and one on a key that cannot be read', async () => {
    // Arrange
    const slow = await provider([hang]);
    const lost = await provider([reply('x')]);
    lost.records.values.delete('wrapping-key');

    // Act
    const timeout = await rejection(requestDeviceCleanup(slow.keys, input({ timeoutMs: 5, debug: true })));
    const unreadable = await rejection(requestDeviceCleanup(lost.keys, input({ debug: true })));

    // Assert
    should(timeout.trace?.failure?.code).equal('timeout');
    should(timeout.trace?.attempts[0]?.status).be.undefined();
    should(timeout.trace?.attempts[0]?.timings.firstByteMs).be.undefined();
    should(unreadable.trace?.failure?.code).equal('provider-auth');
    should(unreadable.trace?.attempts).have.length(1);
  });

  it('should make no record where no call was made', async () => {
    // Arrange
    const none = await provider([reply('x')], { key: false });
    const aborted = new AbortController();
    aborted.abort();

    // Act
    const missing = await requestDeviceCleanup(none.keys, input({ debug: true }));
    const refusal = await rejection(requestDeviceCleanup(none.keys, input({ debug: true, signal: aborted.signal })));
    const badModel = await rejection(requestDeviceCleanup(none.keys, input({ debug: true, model: 'not valid!!' })));
    const empty = await requestDeviceCleanup(none.keys, input({ debug: true, text: '   ' }));

    // Assert
    should(missing).be.undefined();
    should(refusal.trace).be.undefined();
    should(badModel.trace).be.undefined();
    should(empty?.trace).be.undefined();
  });
});

describe('timing a clean-up call with a key this device holds', () => {
  it('should time the call, its first byte and the tokens the provider says it used', async () => {
    // Arrange
    const { keys } = await provider([
      () =>
        Response.json({
          choices: [{ message: { content: 'Hello world, this is the dictation.' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 120, completion_tokens: 9, total_tokens: 129 },
        }),
    ]);

    // Act
    const result = await requestDeviceCleanup(keys, input({ monotonic: ticking(10) }));

    // Assert: reads are call start 0, attempt start 10, first byte 20, attempt end 30, call end 40
    should(result?.timing).eql({ totalMs: 40, firstByteMs: 10, attempts: 1, promptTokens: 120, completionTokens: 9 });
  });

  it('should leave out the tokens when the provider does not say', async () => {
    // Arrange
    const { keys } = await provider([reply('Hello world, this is the dictation.')]);

    // Act
    const result = await requestDeviceCleanup(keys, input({ monotonic: ticking(1) }));

    // Assert
    should(result?.timing).not.have.property('promptTokens');
    should(result?.timing).not.have.property('completionTokens');
  });

  it('should count the retry without the conversation as a second attempt inside one total', async () => {
    // Arrange
    const { keys } = await provider([status(413), reply('Hello world this is the dictation.')]);
    const cleanup = { ...DEFAULT_VOICE_CLEANUP, useConversation: true };

    // Act
    const result = await requestDeviceCleanup(
      keys,
      input({ cleanup, context: ['an earlier message that is long enough to keep'], monotonic: ticking(5) }),
    );

    // Assert
    should(result?.timing?.attempts).equal(2);
    should(result?.timing?.retried).equal('without-context');
    should(result?.timing?.totalMs).be.above(result?.timing?.firstByteMs ?? 0);
  });

  it('should time a call that failed too, since it still took its time', async () => {
    // Arrange
    const { keys } = await provider([status(429)]);

    // Act
    const failure = await rejection(requestDeviceCleanup(keys, input({ monotonic: ticking(7) })));

    // Assert
    should(failure.timing?.attempts).equal(1);
    should(failure.timing?.totalMs).be.above(0);
  });

  it('should time nothing when this device holds no key', async () => {
    // Arrange
    const { keys } = await provider([reply('x')], { key: false });

    // Act
    const result = await requestDeviceCleanup(keys, input({ monotonic: ticking(1) }));

    // Assert
    should(result).be.undefined();
  });
});
