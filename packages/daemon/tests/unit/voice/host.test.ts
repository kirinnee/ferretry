import { describe, expect, test } from 'bun:test';
import { VoiceWorkerHost } from '../../../src/lib/voice/host.ts';
import type { VoiceClock, VoiceWorkerHandle, VoiceWorkerSpawner } from '../../../src/lib/voice/ports.ts';
import type { VoiceWorkerRequest } from '../../../src/lib/voice/ipc.ts';
import { VOICE_FINISH_MS, VOICE_IDLE_MS, VOICE_LOAD_MS } from '../../../src/lib/voice/policy.ts';

class Clock implements VoiceClock {
  time = 0;
  jobs: { at: number; callback(): void; cancelled: boolean }[] = [];
  after(ms: number, callback: () => void): { cancel(): void } {
    const job = { at: this.time + ms, callback, cancelled: false };
    this.jobs.push(job);
    return {
      cancel: () => {
        job.cancelled = true;
      },
    };
  }
  advance(ms: number): void {
    this.time += ms;
    for (const job of [...this.jobs])
      if (!job.cancelled && job.at <= this.time) {
        job.cancelled = true;
        job.callback();
      }
  }
}
async function turns(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}
function fixture(options: { memory?: number; failMemory?: boolean; failSpawn?: boolean } = {}) {
  const clock = new Clock();
  const sent: VoiceWorkerRequest[] = [];
  const errors: unknown[] = [];
  const workers: { handlers: Parameters<VoiceWorkerSpawner['start']>[0]; stopped: number }[] = [];
  let throwSend = false;
  let holdStop: Promise<void> | undefined;
  let holdStart: Promise<void> | undefined;
  const subject = new VoiceWorkerHost({
    clock,
    recognizers: [{ threads: 2, modelId: 'fake', modelBytes: 100, peakResidentBytes: 100, streaming: false }],
    availableMemory: async () => {
      if (options.failMemory) throw new Error('unreadable');
      return options.memory ?? 4 * 1024 ** 3;
    },
    spawner: {
      start: async handlers => {
        if (options.failSpawn) throw new Error('spawn refused');
        await holdStart;
        const worker = { handlers, stopped: 0 };
        workers.push(worker);
        return {
          placement: { hardCapped: true },
          send: message => {
            if (throwSend) throw new Error('disconnected');
            sent.push(message);
          },
          stop: async () => {
            worker.stopped++;
            await holdStop;
          },
        } satisfies VoiceWorkerHandle;
      },
    },
  });
  const reply = (message: VoiceWorkerRequest | undefined = sent.at(-1), error?: string) => {
    if (message === undefined) throw new Error('No job');
    workers.at(-1)?.handlers.message(
      error === undefined
        ? message.type === 'load'
          ? { version: 1, requestId: message.requestId, type: 'health', state: 'loaded' }
          : {
              version: 1,
              requestId: message.requestId,
              streamId: message.streamId,
              streaming: message.streaming,
              type: 'result',
              text: message.type,
              final: message.type === 'finish',
            }
        : { version: 1, requestId: message.requestId, type: 'error', code: error, message: 'refused' },
    );
  };
  const open = async (id = 'one', device = id) => {
    const pending = subject.open(id, device, e => errors.push(e));
    await turns();
    if (sent.at(-1)?.type === 'load') reply();
    return await pending;
  };
  return {
    subject,
    clock,
    sent,
    workers,
    reply,
    open,
    errors,
    throwSend: (value = true) => {
      throwSend = value;
    },
    holdStop: (promise: Promise<void>) => {
      holdStop = promise;
    },
    holdStart: (promise: Promise<void>) => {
      holdStart = promise;
    },
  };
}

describe('VoiceWorkerHost', () => {
  test('lazy one-worker startup is shared and admission reserves two streams, one per device', async () => {
    // Arrange
    const f = fixture();
    expect(f.subject.status().state).toBe('idle');
    expect(f.workers).toHaveLength(0);
    // Act
    const a = f.subject.open('a', 'phone', e => f.errors.push(e));
    const b = f.subject.open('b', 'tablet', e => f.errors.push(e));
    expect(await f.subject.open('c', 'laptop', () => {})).toMatchObject({ code: 'voice_busy' });
    expect(await f.subject.open('d', 'phone', () => {})).toMatchObject({ code: 'voice_busy' });
    await turns();
    expect(f.subject.status().state).toBe('loading');
    f.reply();
    // Assert
    expect(await a).toMatchObject({ ok: true });
    expect(await b).toMatchObject({ ok: true });
    expect(f.workers).toHaveLength(1);
    expect(f.subject.status()).toMatchObject({ state: 'loaded', placement: { hardCapped: true } });
    f.subject.cancel('a');
    f.reply();
    expect(await f.subject.open('a', 'tablet', () => {})).toMatchObject({ code: 'voice_busy' });
    await f.subject.close();
  });
  test('FIFO across streams sends one decode at a time and releases processed audio capacity', async () => {
    // Arrange
    const f = fixture();
    await f.open('a');
    await f.open('b');
    const buffer = new Float32Array(16_000).fill(0.25);
    // Act
    const a = f.subject.audio('a', buffer);
    const b = f.subject.audio('b', buffer);
    const a2 = f.subject.audio('a', buffer);
    buffer.fill(1);
    // Assert
    expect(f.sent.map(m => m.type)).toEqual(['load', 'audio']);
    expect(f.sent[1]).toMatchObject({ streamId: 'a' });
    if (f.sent[1]?.type === 'audio') expect(f.sent[1].samples[0]).toBe(0.25);
    f.reply();
    expect(await a).toMatchObject({ ok: true });
    expect(f.sent.at(-1)).toMatchObject({ streamId: 'b' });
    f.reply();
    await b;
    expect(f.sent.at(-1)).toMatchObject({ streamId: 'a' });
    f.reply();
    await a2;
    const next = f.subject.audio('a', new Float32Array(32_000));
    f.reply();
    expect(await next).toMatchObject({ ok: true });
    const finish = f.subject.finish('a');
    f.reply();
    expect(await finish).toEqual({ ok: true, value: 'finish' });
    await f.subject.close();
  });
  test('more than two seconds unprocessed fails that stream, drops queued audio and keeps the decode slot', async () => {
    // Arrange
    const f = fixture();
    await f.open('a');
    await f.open('b');
    const active = f.subject.audio('a', new Float32Array(16_000));
    const queued = f.subject.audio('a', new Float32Array(16_000));
    const other = f.subject.audio('b', new Float32Array(100));
    // Act
    const behind = await f.subject.audio('a', new Float32Array(1));
    // Assert
    expect(behind).toMatchObject({ code: 'engine_behind' });
    expect(await queued).toMatchObject({ code: 'engine_behind' });
    expect(await active).toMatchObject({ code: 'engine_behind' });
    expect(f.sent).toHaveLength(2);
    f.reply();
    expect(f.sent.at(-1)).toMatchObject({ streamId: 'b' });
    f.reply();
    await other;
    f.reply();
    expect(f.errors).toHaveLength(1);
    await f.subject.close();
  });
  test('finish deadline starts at enqueue, kills a stuck decode and fails all streams', async () => {
    // Arrange
    const f = fixture();
    await f.open('a');
    await f.open('b');
    const audio = f.subject.audio('a', new Float32Array(100));
    const finish = f.subject.finish('b');
    // Act
    f.clock.advance(VOICE_FINISH_MS - 1);
    expect(f.workers[0]?.stopped).toBe(0);
    f.clock.advance(1);
    // Assert
    expect(await finish).toMatchObject({ code: 'engine_timeout' });
    expect(await audio).toMatchObject({ code: 'engine_timeout' });
    expect(f.errors).toHaveLength(2);
    expect(f.workers[0]?.stopped).toBe(1);
    await f.subject.close();
  });
  test('load is bounded and not-installed is a stable failure with no model kept resident', async () => {
    // Arrange
    const f = fixture();
    const opening = f.subject.open('a', 'a', e => f.errors.push(e));
    await turns();
    // Act
    f.clock.advance(VOICE_LOAD_MS);
    // Assert
    expect(await opening).toMatchObject({ code: 'engine_timeout' });
    expect(f.workers[0]?.stopped).toBe(1);
    const retry = f.subject.open('b', 'b', e => f.errors.push(e));
    await turns();
    f.reply(undefined, 'voice_not_installed');
    expect(await retry).toMatchObject({ code: 'voice_not_installed' });
    await f.subject.close();
  });
  test('idle exit is ten minutes after last stream; a new stream cancels it', async () => {
    // Arrange
    const f = fixture();
    await f.open();
    const final = f.subject.finish('one');
    f.reply();
    await final;
    // Act
    f.clock.advance(VOICE_IDLE_MS - 1);
    expect(f.workers[0]?.stopped).toBe(0);
    await f.open('two');
    f.clock.advance(1);
    expect(f.workers[0]?.stopped).toBe(0);
    f.subject.cancel('two');
    f.reply();
    f.clock.advance(VOICE_IDLE_MS);
    // Assert
    expect(f.workers[0]?.stopped).toBe(1);
    expect(f.subject.status().state).toBe('idle');
    await f.open('three');
    expect(f.workers).toHaveLength(2);
    await f.subject.close();
  });
  test('last stream cancelled during a delayed spawn still gets the ten minute idle exit', async () => {
    // Arrange
    const f = fixture();
    const start = Promise.withResolvers<void>();
    f.holdStart(start.promise);
    const opening = f.subject.open('one', 'one', e => f.errors.push(e));
    await turns();
    // Act
    f.subject.cancel('one');
    start.resolve();
    await turns();
    f.reply();
    // Assert
    expect(await opening).toMatchObject({ code: 'voice_cancelled' });
    f.clock.advance(VOICE_IDLE_MS - 1);
    expect(f.workers[0]?.stopped).toBe(0);
    f.clock.advance(1);
    expect(f.workers[0]?.stopped).toBe(1);
    expect(f.subject.status().state).toBe('idle');
    await f.subject.close();
  });
  test('a stream that arrives during that delayed spawn keeps the worker alive', async () => {
    // Arrange
    const f = fixture();
    const start = Promise.withResolvers<void>();
    f.holdStart(start.promise);
    const first = f.subject.open('one', 'one', e => f.errors.push(e));
    await turns();
    f.subject.cancel('one');
    const second = f.subject.open('two', 'two', e => f.errors.push(e));
    // Act
    start.resolve();
    await turns();
    f.reply();
    await first;
    f.clock.advance(VOICE_IDLE_MS * 2);
    // Assert
    expect(await second).toMatchObject({ ok: true });
    expect(f.workers[0]?.stopped).toBe(0);
    expect(f.subject.status().state).toBe('loaded');
    await f.subject.close();
  });
  test('crash fails streams, stale replies are ignored, replacement waits for the old child to exit', async () => {
    // Arrange
    const f = fixture();
    await f.open();
    const gate = Promise.withResolvers<void>();
    f.holdStop(gate.promise);
    const old = f.workers[0];
    const audio = f.subject.audio('one', new Float32Array(1));
    // Act
    old?.handlers.exited('native crash');
    expect(await audio).toMatchObject({ code: 'worker_crashed' });
    const retry = f.subject.open('two', 'two', () => {});
    await turns();
    expect(f.workers).toHaveLength(1);
    gate.resolve();
    await turns();
    old?.handlers.message({ invalid: true });
    old?.handlers.exited('stale');
    f.reply();
    // Assert
    expect(await retry).toMatchObject({ ok: true });
    expect(f.workers).toHaveLength(2);
    await f.subject.close();
  });
  test('memory headroom refuses before spawning; memory IO and spawn refusal become failures', async () => {
    // Arrange / Act / Assert
    for (const options of [{ memory: 1024 ** 3 + 99 }, { failMemory: true }, { failSpawn: true }]) {
      const f = fixture(options);
      expect(await f.open()).toMatchObject({ code: options.memory ? 'voice_no_memory' : 'worker_crashed' });
      expect(f.workers).toHaveLength(0);
      await f.subject.close();
    }
    const f = fixture({ memory: 1024 ** 3 + 100 });
    expect(await f.open()).toMatchObject({ ok: true });
    await f.subject.close();
  });
  test('cancel during warm-up and close during spawn never leave a child or pending promise', async () => {
    // Arrange
    const f = fixture();
    const opening = f.subject.open('a', 'a', () => {});
    // Act
    f.subject.cancel('a');
    f.subject.cancel('missing');
    // Assert
    expect(await opening).toMatchObject({ code: 'voice_cancelled' });
    expect(f.workers).toHaveLength(0);
    const gate = Promise.withResolvers<VoiceWorkerHandle>();
    const subject = new VoiceWorkerHost({
      clock: f.clock,
      recognizers: [{ threads: 1, modelId: 'fake', modelBytes: 0, peakResidentBytes: 0, streaming: false }],
      availableMemory: async () => 2 ** 31,
      spawner: { start: async () => await gate.promise },
    });
    const pending = subject.open('a', 'a', () => {});
    await turns();
    const closing = subject.close();
    let stopped = false;
    gate.resolve({
      placement: { hardCapped: false, reason: 'test' },
      send: () => {},
      stop: async () => {
        stopped = true;
      },
    });
    await closing;
    expect(await pending).toMatchObject({ code: 'worker_crashed' });
    expect(stopped).toBe(true);
    expect(await subject.open('b', 'b', () => {})).toMatchObject({ code: 'voice_cancelled' });
    await subject.close();
  });
  test('malformed and mismatched responses, disconnected IPC and recognizer errors fail explicitly', async () => {
    // Arrange / Act / Assert
    for (const raw of [
      { bad: true },
      { version: 1, type: 'result', requestId: '2', streamId: 'wrong', streaming: false, text: '', final: false },
    ]) {
      const f = fixture();
      await f.open();
      const audio = f.subject.audio('one', new Float32Array(1));
      f.workers[0]?.handlers.message(raw);
      expect(await audio).toMatchObject({ code: 'worker_protocol' });
      await f.subject.close();
    }
    const f = fixture();
    await f.open();
    f.workers[0]?.handlers.message({ version: 1, type: 'health', requestId: 'startup', state: 'ready' });
    f.workers[0]?.handlers.message({
      version: 1,
      type: 'result',
      requestId: 'stale',
      streamId: 'one',
      streaming: false,
      text: '',
      final: false,
    });
    const audio = f.subject.audio('one', new Float32Array(1));
    f.reply(undefined, 'engine_behind');
    expect(await audio).toMatchObject({ code: 'engine_behind' });
    f.reply();
    await f.open('two');
    f.throwSend();
    expect(await f.subject.audio('two', new Float32Array(1))).toMatchObject({ code: 'worker_crashed' });
    await f.subject.close();
  });
  test('finishing streams reject more input and duplicate finish; absent streams reject input', async () => {
    // Arrange
    const f = fixture();
    await f.open();
    // Act
    const final = f.subject.finish('one');
    // Assert
    expect(await f.subject.audio('one', new Float32Array(1))).toMatchObject({ code: 'voice_cancelled' });
    expect(await f.subject.finish('one')).toMatchObject({ code: 'voice_cancelled' });
    expect(await f.subject.audio('missing', new Float32Array(1))).toMatchObject({ code: 'voice_cancelled' });
    expect(await f.subject.finish('missing')).toMatchObject({ code: 'voice_cancelled' });
    f.reply();
    await final;
    await f.subject.close();
  });
  test('cancelled native work is still bounded', async () => {
    // Arrange
    const f = fixture();
    await f.open();
    const audio = f.subject.audio('one', new Float32Array(1));
    // Act
    f.subject.cancel('one');
    await audio;
    f.clock.advance(VOICE_FINISH_MS);
    // Assert
    expect(f.workers[0]?.stopped).toBe(1);
    await f.subject.close();
  });
});

test('cancelled stream IDs cannot be reused until worker cancellation is acknowledged', async () => {
  // Arrange
  const f = fixture();
  await f.open();
  const audio = f.subject.audio('one', new Float32Array(16_000));
  // Act
  f.subject.cancel('one');
  await audio;
  // Assert
  expect(await f.subject.open('one', 'new-device', () => {})).toMatchObject({ code: 'voice_busy' });
  f.reply();
  f.reply();
  expect(await f.open()).toMatchObject({ ok: true });
  await f.subject.close();
});

test('model switching refuses low memory before unloading; successful switch reaps the old set first', async () => {
  // Arrange
  const f = fixture();
  await f.open();
  const final = f.subject.finish('one');
  f.reply();
  await final;
  const gate = Promise.withResolvers<void>();
  f.holdStop(gate.promise);
  const selected = [
    { modelId: 'batch', modelBytes: 100, peakResidentBytes: 2_000_000_000, streaming: false, threads: 2 },
    { modelId: 'stream', modelBytes: 100, peakResidentBytes: 500_000_000, streaming: true, threads: 2 },
  ];
  // Act / Assert
  expect(await f.subject.selectRecognizers([{ ...selected[0]!, modelBytes: 8 * 1024 ** 3 }])).toMatchObject({
    code: 'voice_no_memory',
  });
  expect(f.workers[0]?.stopped).toBe(0);
  const changing = f.subject.selectRecognizers(selected);
  await turns();
  expect(f.workers[0]?.stopped).toBe(1);
  expect(await f.subject.open('b', 'b', () => {})).toMatchObject({ code: 'voice_busy' });
  expect(await f.subject.selectRecognizers(selected)).toMatchObject({ code: 'voice_busy' });
  gate.resolve();
  expect(await changing).toMatchObject({ ok: true });
  const opening = f.subject.open('stream', 'stream', () => {}, true);
  await turns();
  expect(f.sent.at(-1)).toMatchObject({ type: 'load', recognizers: selected });
  f.reply();
  expect(await opening).toMatchObject({ ok: true });
  expect(await f.subject.selectRecognizers(selected)).toMatchObject({ code: 'voice_busy' });
  await f.subject.close();
  expect(await f.subject.selectRecognizers(selected)).toMatchObject({ code: 'voice_cancelled' });
});
test('unselected streaming model is refused without a worker, and failed headroom reads refuse switches', async () => {
  // Arrange
  const f = fixture({ failMemory: true });
  // Act / Assert
  expect(await f.subject.open('a', 'a', () => {}, true)).toMatchObject({ code: 'voice_not_installed' });
  expect(
    await f.subject.selectRecognizers([
      { modelId: 'batch', modelBytes: 100, peakResidentBytes: 100, streaming: false, threads: 1 },
    ]),
  ).toMatchObject({ code: 'voice_no_memory' });
  await f.subject.close();
});

test('an invalid active model set is refused before admission or process startup', async () => {
  // Arrange
  const f = fixture();
  const model = { modelId: 'batch', modelBytes: 100, peakResidentBytes: 100, streaming: false, threads: 1 };
  // Act / Assert
  expect(await f.subject.selectRecognizers([model, { ...model, modelId: 'other' }])).toMatchObject({
    code: 'worker_protocol',
  });
  expect(f.workers).toHaveLength(0);
  await f.subject.close();
});

test('cancelled streams hold admission until their native state is released; failed cancellation resets the worker', async () => {
  // Arrange
  const f = fixture();
  await f.open('a', 'phone');
  await f.open('b', 'tablet');
  const active = f.subject.audio('a', new Float32Array(1));
  f.subject.cancel('a');
  await active;
  // Act / Assert
  expect(await f.subject.open('c', 'laptop', () => {})).toMatchObject({ code: 'voice_busy' });
  f.reply();
  f.reply(undefined, 'worker_crashed');
  expect(f.workers[0]?.stopped).toBe(1);
  expect(await f.open('c', 'phone')).toMatchObject({ ok: true });
  await f.subject.close();
});

test('empty audio creates no queue jobs while a decode is pending', async () => {
  // Arrange
  const f = fixture();
  await f.open();
  const active = f.subject.audio('one', new Float32Array(1));
  // Act
  expect(await f.subject.audio('one', new Float32Array(0))).toEqual({ ok: true, value: '' });
  // Assert
  expect(f.sent).toHaveLength(2);
  f.reply();
  await active;
  await f.subject.close();
});

test('a load reply followed by a failed queued cancel never resurrects a loaded state without a child', async () => {
  // Arrange
  const f = fixture();
  const opening = f.subject.open('one', 'one', e => f.errors.push(e));
  await turns();
  f.subject.cancel('one');
  // Act: the load reply releases the queue, the queued cancel cannot be sent, and the host aborts before warm resumes
  f.throwSend();
  f.reply();
  // Assert
  expect(await opening).toMatchObject({ ok: false, code: 'worker_crashed' });
  expect(f.subject.status().state).toBe('idle');
  expect(f.workers[0]?.stopped).toBe(1);
  f.throwSend(false);
  expect(await f.open('two', 'two')).toMatchObject({ ok: true });
  expect(f.workers).toHaveLength(2);
  await f.subject.close();
});

test('a load reply immediately followed by the child exiting leaves the host unloaded so the next open respawns', async () => {
  // Arrange
  const f = fixture();
  const opening = f.subject.open('one', 'one', e => f.errors.push(e));
  await turns();
  // Act
  f.reply();
  f.workers[0]?.handlers.exited('gone');
  // Assert
  expect(await opening).toMatchObject({ ok: false, code: 'worker_crashed' });
  expect(f.subject.status().state).toBe('idle');
  expect(await f.open('two', 'two')).toMatchObject({ ok: true });
  expect(f.workers).toHaveLength(2);
  await f.subject.close();
});

test('a direct cancel with no reply stops the worker after the finish deadline and frees admission', async () => {
  // Arrange
  const f = fixture();
  await f.open('a', 'phone');
  await f.open('b', 'tablet');
  // Act
  f.subject.cancel('a');
  expect(f.sent.at(-1)).toMatchObject({ type: 'cancel', streamId: 'a' });
  expect(await f.subject.open('c', 'laptop', () => {})).toMatchObject({ code: 'voice_busy' });
  f.clock.advance(VOICE_FINISH_MS - 1);
  expect(f.workers[0]?.stopped).toBe(0);
  f.clock.advance(1);
  // Assert
  expect(f.workers[0]?.stopped).toBe(1);
  expect(f.subject.status().state).toBe('idle');
  expect(await f.open('c', 'phone')).toMatchObject({ ok: true });
  await f.subject.close();
});

test('a cancel queued behind a decode gets its deadline when it is sent, not when it was enqueued', async () => {
  // Arrange
  const f = fixture();
  await f.open('a', 'phone');
  await f.open('b', 'tablet');
  const audio = f.subject.audio('a', new Float32Array(1));
  f.clock.advance(VOICE_FINISH_MS - 1000);
  f.subject.cancel('a');
  await audio;
  f.clock.advance(VOICE_FINISH_MS - 1000 - 1);
  // Act: the decode finishes late; only now is the cancel sent
  f.reply();
  expect(f.sent.at(-1)).toMatchObject({ type: 'cancel', streamId: 'a' });
  f.clock.advance(VOICE_FINISH_MS - 1);
  // Assert
  expect(f.workers[0]?.stopped).toBe(0);
  f.clock.advance(1);
  expect(f.workers[0]?.stopped).toBe(1);
  await f.subject.close();
});

test('a cancel after an audio reply is bounded while another stream stays open', async () => {
  // Arrange
  const f = fixture();
  await f.open('a', 'phone');
  await f.open('b', 'tablet');
  const audio = f.subject.audio('a', new Float32Array(1));
  f.reply();
  await audio;
  // Act
  f.subject.cancel('a');
  f.clock.advance(VOICE_FINISH_MS);
  // Assert
  expect(f.workers[0]?.stopped).toBe(1);
  await f.subject.close();
});

test('a cancel answered in time sets no abort', async () => {
  // Arrange
  const f = fixture();
  await f.open('a', 'phone');
  await f.open('b', 'tablet');
  // Act
  f.subject.cancel('a');
  f.reply();
  f.clock.advance(VOICE_FINISH_MS * 2);
  // Assert
  expect(f.workers[0]?.stopped).toBe(0);
  expect(f.errors).toHaveLength(1);
  expect(await f.open('c', 'phone')).toMatchObject({ ok: true });
  await f.subject.close();
});
