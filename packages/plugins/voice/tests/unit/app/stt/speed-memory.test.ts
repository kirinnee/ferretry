/**
 * Proves what a device remembers about failed speed paths (`speed-memory.ts`): it is versioned, capped and
 * zod-parsed field by field, it never throws on hostile storage, and a refused write is an ordinary outcome.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import {
  MAX_FAILURES,
  parseSpeedMemory,
  SPEED_MEMORY_KEY,
  SPEED_MEMORY_VERSION,
  SpeedMemoryStore,
  serialiseSpeedMemory,
} from '../../../../app/lib/stt/speed-memory.ts';
import { FAILURE_FORGET_MS, NO_MEMORY } from '../../../../app/lib/stt/speed-plan.ts';

const NOW = 1_800_000_000_000;

class FakeStorage {
  readonly items = new Map<string, string>();
  denyWrites = false;
  denyReads = false;
  getItem(key: string): string | null {
    if (this.denyReads) throw new Error('storage blocked');
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.denyWrites) throw new Error('quota');
    this.items.set(key, value);
  }
}

describe('parseSpeedMemory', () => {
  it('reads nothing as nothing learned', () => {
    should(parseSpeedMemory(null)).equal(NO_MEMORY);
    should(parseSpeedMemory('')).equal(NO_MEMORY);
    should(parseSpeedMemory('not json')).equal(NO_MEMORY);
    should(parseSpeedMemory('[]')).equal(NO_MEMORY);
    should(parseSpeedMemory('null')).equal(NO_MEMORY);
  });

  it('discards a payload from a version it does not know', () => {
    const payload = { v: SPEED_MEMORY_VERSION + 1, failures: [{ model: 'parakeet', path: 'wasm-threads', at: NOW }] };
    should(parseSpeedMemory(JSON.stringify(payload))).equal(NO_MEMORY);
  });

  it('keeps the good entries and drops the bad ones, one by one', () => {
    const payload = {
      v: SPEED_MEMORY_VERSION,
      failures: [
        { model: 'parakeet', path: 'wasm-threads', at: NOW },
        { model: 'no-such-model', path: 'wasm-threads', at: NOW },
        { model: 'parakeet', path: 'no-such-path', at: NOW },
        { model: 'parakeet', path: 'webgpu', at: -1 },
        { model: 'parakeet', path: 'webgpu', at: 'yesterday' },
        { model: 'vosk-small-en', path: 'wasm-threads', at: NOW, extra: 'a transcript?' },
        'junk',
        null,
        { model: 'whisper-base-en', path: 'webgpu', at: NOW - 5 },
      ],
    };
    should(parseSpeedMemory(JSON.stringify(payload)).failures).deepEqual([
      { model: 'parakeet', path: 'wasm-threads', at: NOW },
      { model: 'whisper-base-en', path: 'webgpu', at: NOW - 5 },
    ]);
  });

  it('keeps one entry per model and path, the newest', () => {
    const payload = {
      v: SPEED_MEMORY_VERSION,
      failures: [
        { model: 'parakeet', path: 'wasm-threads', at: 1 },
        { model: 'parakeet', path: 'wasm-threads', at: 9 },
      ],
    };
    should(parseSpeedMemory(JSON.stringify(payload)).failures).deepEqual([
      { model: 'parakeet', path: 'wasm-threads', at: 9 },
    ]);
  });

  it('refuses an oversized payload without parsing it', () => {
    const big = JSON.stringify({ v: SPEED_MEMORY_VERSION, failures: [], pad: 'x'.repeat(10_000) });
    should(parseSpeedMemory(big)).equal(NO_MEMORY);
  });

  it('caps what it reads', () => {
    const paths = ['webgpu', 'wasm-threads', 'wasm-single'];
    const models = ['parakeet', 'whisper-tiny-en', 'whisper-base-en', 'parakeet-tdt-110m'];
    const failures = Array.from({ length: 500 }, (_, i) => ({
      model: models[i % models.length],
      path: paths[i % paths.length],
      at: NOW + i,
    }));
    should(parseSpeedMemory(JSON.stringify({ v: SPEED_MEMORY_VERSION, failures })).failures.length).be.belowOrEqual(
      MAX_FAILURES,
    );
  });

  it('round-trips through serialise', () => {
    const memory = { failures: [{ model: 'parakeet' as const, path: 'wasm-threads' as const, at: NOW }] };
    should(parseSpeedMemory(serialiseSpeedMemory(memory))).deepEqual(memory);
  });
});

describe('SpeedMemoryStore', () => {
  it('records a failure under fy:voice:speed-memory and reads it back', () => {
    const storage = new FakeStorage();
    const store = new SpeedMemoryStore(storage);
    should(store.recordFailure('parakeet', 'wasm-threads', NOW)).equal(true);
    should(storage.items.has(SPEED_MEMORY_KEY)).equal(true);
    should(SPEED_MEMORY_KEY).equal('fy:voice:speed-memory');
    should(new SpeedMemoryStore(storage).read().failures).deepEqual([
      { model: 'parakeet', path: 'wasm-threads', at: NOW },
    ]);
  });

  it('stores no words: only a model id, a path and a time', () => {
    const storage = new FakeStorage();
    new SpeedMemoryStore(storage).recordFailure('parakeet', 'wasm-threads', NOW);
    should(Object.keys(JSON.parse(storage.items.get(SPEED_MEMORY_KEY) as string).failures[0]).sort()).deepEqual([
      'at',
      'model',
      'path',
    ]);
  });

  it('forgets a failure after a week when the next one is recorded', () => {
    const store = new SpeedMemoryStore(new FakeStorage());
    store.recordFailure('parakeet', 'wasm-threads', NOW);
    store.recordFailure('whisper-base-en', 'wasm-threads', NOW + FAILURE_FORGET_MS + 1);
    should(store.read().failures.map(failure => failure.model)).deepEqual(['whisper-base-en']);
  });

  it('keeps working in this page when storage refuses writes', () => {
    const storage = new FakeStorage();
    storage.denyWrites = true;
    const store = new SpeedMemoryStore(storage);
    should(store.recordFailure('parakeet', 'wasm-threads', NOW)).equal(false);
  });

  it('remembers failures in this page after storage refuses a write, merged with what storage holds', () => {
    const storage = new FakeStorage();
    storage.items.set(
      SPEED_MEMORY_KEY,
      serialiseSpeedMemory({ failures: [{ model: 'whisper-base-en', path: 'webgpu', at: NOW - 1_000 }] }),
    );
    storage.denyWrites = true;
    const store = new SpeedMemoryStore(storage);
    should(store.recordFailure('parakeet', 'wasm-threads', NOW)).equal(false);
    should(store.read().failures).deepEqual([
      { model: 'parakeet', path: 'wasm-threads', at: NOW },
      { model: 'whisper-base-en', path: 'webgpu', at: NOW - 1_000 },
    ]);
    // A second refused write keeps the first, and the next accepted write persists both.
    should(store.recordFailure('parakeet', 'webgpu', NOW + 1)).equal(false);
    should(store.read().failures.map(failure => failure.path)).deepEqual(['webgpu', 'wasm-threads', 'webgpu']);
    storage.denyWrites = false;
    should(store.recordFailure('whisper-tiny-en', 'wasm-threads', NOW + 2)).equal(true);
    should(new SpeedMemoryStore(storage).read().failures.length).equal(4);
    // Once persisted, reads follow storage again (another tab's change is seen).
    storage.items.set(SPEED_MEMORY_KEY, serialiseSpeedMemory(NO_MEMORY));
    should(store.read()).deepEqual({ failures: [] });
  });

  it('reads nothing when storage refuses reads, and never throws', () => {
    const storage = new FakeStorage();
    storage.denyReads = true;
    should(new SpeedMemoryStore(storage).read()).equal(NO_MEMORY);
  });

  it('works with no storage at all, remembering for this page', () => {
    const store = new SpeedMemoryStore(null);
    should(store.read()).equal(NO_MEMORY);
    should(store.recordFailure('parakeet', 'wasm-threads', NOW)).equal(false);
    should(store.read().failures).deepEqual([{ model: 'parakeet', path: 'wasm-threads', at: NOW }]);
  });
});
