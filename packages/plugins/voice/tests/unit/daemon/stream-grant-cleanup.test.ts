import { expect, test } from 'bun:test';
import { fixedClock } from '@ferretry/kernel/testing';
import type { CallerGovernance } from '@ferretry/core-gate/contract';
import { decodeDownlinkUnit, STREAM_CLOSES, TICK_MS } from '../../../contract/index.ts';
import { voiceStreamAccept } from '../../../daemon/lib/stream/accept.ts';
import { StreamRegistry } from '../../../daemon/lib/stream/registry.ts';

async function open() {
  const clock = fixedClock();
  const registry = new StreamRegistry();
  const watchers = new Set<() => void>();
  const frames: Uint8Array[] = [];
  const closes: unknown[] = [];
  let allowed = true;
  let checkThrows = false;
  let sendThrows = false;
  const governance: CallerGovernance = {
    governed: true,
    decide: () => {
      if (checkThrows) throw new Error('grant reader failed');
      return { allowed } as ReturnType<CallerGovernance['decide']>;
    },
    watch: listener => {
      watchers.add(listener);
      return () => void watchers.delete(listener);
    },
  };
  const accept = voiceStreamAccept({
    engine: {
      view: async () => ({ state: 'ready', machine: 'synthetic' }) as never,
      detectSpeech: async () => [],
      transcribe: async () => ({ text: '', decodeMs: 0, realTimeFactor: 0 }),
    },
    clock,
    registry,
    send: () => async () => ({ ok: true }),
    resolveFerret: async reference => reference,
    fleetUseGranted: () => true,
    audit: async () => undefined,
    log: { info: () => undefined },
  });
  const stream = await (
    await accept({
      governance,
      credential: { tokenClass: 'device', principal: { holder: 'phone' } },
    } as never)
  )({
    send: frame => {
      if (sendThrows) throw new Error('fatal frame transport failed');
      frames.push(frame as Uint8Array);
      return (frame as Uint8Array).byteLength;
    },
    close: (code, reason) => void closes.push({ code, reason }),
    bufferedBytes: () => 0,
  });
  await stream.open();
  return {
    stream,
    clock,
    registry,
    watchers,
    frames,
    closes,
    cut: (options: { checkThrows?: boolean; sendThrows?: boolean } = {}) => {
      allowed = false;
      checkThrows = options.checkThrows ?? false;
      sendThrows = options.sendThrows ?? false;
    },
  };
}

const chat = JSON.stringify({ t: 'start', v: 1, purpose: 'chat', ferretId: 'fer-1' });

for (const checkThrows of [false, true]) {
  test(`missed grant notification closes idle chat within one loop period (reader throws: ${checkThrows})`, async () => {
    const r = await open();
    try {
      r.stream.fromClient(chat);
      await new Promise(resolve => setTimeout(resolve, 0));
      await r.clock.advance(TICK_MS * 2);
      expect(r.frames.map(decodeDownlinkUnit).at(-1)?.state).toBe('listening');
      expect(r.registry.claimFerret('fer-1')).toBeUndefined();
      r.cut({ checkThrows }); // Deliberately never call the grant watcher.
      await r.clock.advance(TICK_MS);
      expect(r.closes).toEqual([STREAM_CLOSES.forbidden]);
      expect(r.frames.map(decodeDownlinkUnit).at(-1)?.error?.code).toBe('fleet_not_granted');
      expect(r.watchers.size).toBe(0);
      expect(r.registry.wouldAdmit('device:phone')).toBe('ok');
      expect(r.registry.claimFerret('fer-1')).toBeFunction();
      expect(r.clock.pending()).toBe(0);
    } finally {
      r.stream.close();
    }
  });
}

test('fatal frame send throwing still closes and releases both claims, timers and grant subscription', async () => {
  const r = await open();
  try {
    r.stream.fromClient(chat);
    await new Promise(resolve => setTimeout(resolve, 0));
    await r.clock.advance(TICK_MS * 2);
    expect(r.registry.claimFerret('fer-1')).toBeUndefined();
    r.cut({ sendThrows: true });
    for (const notify of r.watchers) {
      try {
        notify();
      } catch {
        /* Gate isolates a failing notification callback. */
      }
    }
    expect(r.closes).toEqual([STREAM_CLOSES.forbidden]);
    expect(r.watchers.size).toBe(0);
    expect(r.registry.wouldAdmit('device:phone')).toBe('ok');
    expect(r.registry.claimFerret('fer-1')).toBeFunction();
    expect(r.clock.pending()).toBe(0);
  } finally {
    r.stream.close();
  }
});

test('Talk to test remains open when a fleet check would fail', async () => {
  const r = await open();
  try {
    r.stream.fromClient(JSON.stringify({ t: 'start', v: 1, purpose: 'test' }));
    r.cut({ checkThrows: true });
    for (const notify of r.watchers) notify();
    await r.clock.advance(TICK_MS);
    expect(r.closes).toEqual([]);
  } finally {
    r.stream.close();
  }
});
