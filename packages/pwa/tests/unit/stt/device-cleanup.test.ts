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
import { RemoteEnhancementError } from '../../../src/lib/stt/remote-enhancement.ts';
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

/** Never answers; rejects the way fetch does when its signal aborts. */
const hang: Answer = (_call, signal) =>
  new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
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
    should(result).eql({ text: 'Hello world, this is the dictation.', provider: 'groq', model: 'openai/gpt-oss-120b' });
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
    should(result).eql({
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
