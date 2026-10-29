import { describe, expect, it } from 'bun:test';
import type { FyApiClient } from '@ferretry/protocol/client';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DaemonConnectionRepository } from '../../src/lib/connections.ts';
import { daemonConnection, type DaemonId } from '../../src/lib/daemon-connection.ts';
import type { StepUpGate } from '../../src/lib/step-up-gate.ts';
import { browserParakeetVoice } from '../../src/lib/stt/parakeet-voice.ts';
import { createAppStore, useLockedMachines } from '../../src/lib/store.tsx';

class MemoryRepository implements DaemonConnectionRepository {
  readonly values = new Map<string, string>();

  async load(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async save(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

const open = async (options: Partial<Parameters<typeof createAppStore>[0]> = {}) =>
  await createAppStore({
    repository: new MemoryRepository(),
    connectClient: async () => ({}) as FyApiClient,
    fetcher: async () => Response.json({}),
    ...options,
  });

describe('the app store’s on-device voices', () => {
  it('lists only the injected voice when a suite supplies a voice and no catalogue', async () => {
    const voice = browserParakeetVoice(globalThis as never, null);

    const store = await open({ voice });

    expect(store.voice).toBe(voice);
    expect(store.voices.list()).toEqual([voice]);
    expect(store.voices.get(voice.model.id)).toBe(voice);
  });
});

describe('the app store in a browser whose storage accessor throws', () => {
  it('opens and keeps pairing without a landing marker', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('denied');
      },
    });
    try {
      const store = await open();

      const alpha = daemonConnection({ daemonId: 'alpha', baseUrl: 'https://alpha.example.test', deviceId: 'device' });
      expect(() => store.connections.add(alpha)).not.toThrow();
      expect(store.connections.list().map(daemon => daemon.daemonId)).toEqual(['alpha' as DaemonId]);
    } finally {
      if (original === undefined) Reflect.deleteProperty(globalThis, 'localStorage');
      else Object.defineProperty(globalThis, 'localStorage', original);
    }
  });
});

describe('useLockedMachines', () => {
  it('reads the machines waiting on an unlock when rendered without a client', () => {
    const gate = {
      subscribe: () => () => undefined,
      waitingDaemons: () => ['alpha', 'beta'] as unknown as readonly DaemonId[],
    } as unknown as StepUpGate;
    function Locked() {
      return <p>{useLockedMachines(gate).join(',')}</p>;
    }

    expect(renderToStaticMarkup(<Locked />)).toBe('<p>alpha,beta</p>');
  });
});
