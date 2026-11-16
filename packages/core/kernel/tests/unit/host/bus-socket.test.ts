/** V-0452 / R537: `GET /v1/bus` — the kernel serves the plugin event bus, filtered by what the caller may discover. */
import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { AdmissionPort, type Admission } from '../../../contract/bound.ts';
import { defineEvent } from '../../../contract/define.ts';
import type { SocketDownstream } from '../../../contract/socket.ts';
import { bootHost } from '../../../host/host.ts';
import { realAdapters } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { fixedClock } from '../../../testing/clock.ts';
import { recordingAdmission, request } from './fixtures.ts';

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

const Moved = defineEvent('board.card-moved', z.strictObject({ card: z.string() }));
const Secret = defineEvent('voice.heard', z.strictObject({ text: z.string() }));
const Alarm = defineEvent('gate.alarm', z.strictObject({ level: z.string() }));
const gate = definePlugin({
  id: 'gate',
  title: 'Gate',
  version: '5.0.0',
  api: 5,
  core: true,
  kinds: [],
  provides: { admission: AdmissionPort },
  data: { publishes: [Alarm] },
});
const board = definePlugin({
  id: 'board',
  title: 'Board',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: [],
  data: { publishes: [Moved] },
});
const voice = definePlugin({
  id: 'voice',
  title: 'Voice',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: [],
  data: { publishes: [Secret] },
});

function downstream() {
  const sent: { frame: string; permit: (() => boolean) | undefined }[] = [];
  const closed: { code: number; reason: string }[] = [];
  let buffered = 0;
  const port: SocketDownstream = {
    send: (frame, permit) => {
      sent.push({ frame: String(frame), permit });
      return String(frame).length;
    },
    close: (code, reason) => void closed.push({ code, reason }),
    bufferedBytes: () => buffered,
  };
  return { port, sent, closed, buffer: (bytes: number) => (buffered = bytes) };
}

async function boot(admission: Admission) {
  const root = await mkdtemp(`${tmpdir()}/bus-socket-`);
  roots.push(root);
  const home = `${root}/home`;
  const published: Record<string, (event: typeof Moved | typeof Secret | typeof Alarm, payload: unknown) => void> = {};
  const outcome = await bootHost({
    home,
    version: '5.0.0',
    adapters: {
      ...realAdapters(home, () => {}, { binary: 'fy' }),
      clock: fixedClock(),
      homeLock: async () => ({ release: async () => {} }),
    },
    implementations: [
      implementDaemon(gate, {
        build: ({ kernel }) => {
          published['gate'] = (event, payload) => kernel.events.publish(event as typeof Alarm, payload as never);
          return { provides: { admission } };
        },
      }),
      implementDaemon(board, {
        build: ({ kernel }) => {
          published['board'] = (event, payload) => kernel.events.publish(event as typeof Moved, payload as never);
          return {};
        },
      }),
      implementDaemon(voice, {
        build: ({ kernel }) => {
          published['voice'] = (event, payload) => kernel.events.publish(event as typeof Secret, payload as never);
          return {};
        },
      }),
    ],
  });
  if (outcome.kind !== 'running') throw new Error(outcome.sentence);
  return { host: outcome.host, published };
}

const flush = async (): Promise<void> => {
  await Bun.sleep(5);
};

test('V-0452 the bus socket sends one { name, payload } frame per event the caller may discover, and not the rest', async () => {
  const admission = recordingAdmission();
  // this caller may discover core and Board, not Voice
  const limited: Admission = {
    ...admission,
    inventory: (_request, entries) => entries.filter(entry => entry.id !== 'voice'),
  };
  const { host, published } = await boot(limited);
  try {
    const decision = await host.dispatcher.upgrade(request('GET', '/v1/bus'));
    if (decision.outcome !== 'accepted') throw new Error(`upgrade ${decision.outcome}`);
    const feed = downstream();
    const handler = await decision.attach(feed.port);
    await handler.open();
    published['board']?.(Moved, { card: 'F1' });
    published['voice']?.(Secret, { text: 'never shown' });
    await flush();
    expect(feed.sent.map(entry => JSON.parse(entry.frame))).toEqual([
      { name: 'board.card-moved', payload: { card: 'F1' } },
    ]);
    expect(feed.sent.some(entry => entry.frame.includes('never shown'))).toBe(false);
    // each frame carries the immediate pre-write permit
    expect(feed.sent[0]?.permit?.()).toBe(true);
    handler.close();
    published['board']?.(Moved, { card: 'F2' });
    await flush();
    expect(feed.sent).toHaveLength(1);
  } finally {
    await host.stop();
  }
});

test('R537 a caller whose view narrows after the frame was queued gets nothing: the permit asks again', async () => {
  let showVoice = true;
  const admission: Admission = {
    ...recordingAdmission(),
    inventory: (_request, entries) => entries.filter(entry => entry.id !== 'voice' || showVoice),
  };
  const { host, published } = await boot(admission);
  try {
    const decision = await host.dispatcher.upgrade(request('GET', '/v1/bus'));
    if (decision.outcome !== 'accepted') throw new Error('upgrade');
    const feed = downstream();
    const handler = await decision.attach(feed.port);
    await handler.open();
    published['voice']?.(Secret, { text: 'now' });
    await flush();
    expect(feed.sent).toHaveLength(1);
    showVoice = false;
    expect(feed.sent[0]?.permit?.()).toBe(false);
    published['voice']?.(Secret, { text: 'later' });
    await flush();
    expect(feed.sent).toHaveLength(1);
    handler.close();
  } finally {
    await host.stop();
  }
});

test('the feed is server-only and a reader that falls behind is closed', async () => {
  const { host, published } = await boot(recordingAdmission());
  try {
    const decision = await host.dispatcher.upgrade(request('GET', '/v1/bus'));
    if (decision.outcome !== 'accepted') throw new Error('upgrade');
    const talker = downstream();
    const first = await decision.attach(talker.port);
    await first.open();
    first.fromClient('hello');
    expect(talker.closed).toEqual([{ code: 1008, reason: 'event feed is server-only' }]);
    const slow = downstream();
    const second = await decision.attach(slow.port);
    await second.open();
    slow.buffer(2 * 1024 * 1024);
    published['board']?.(Moved, { card: 'F9' });
    await flush();
    expect(slow.closed).toEqual([{ code: 1013, reason: 'event feed reader fell behind' }]);
  } finally {
    await host.stop();
  }
});

test('V-0452 when Gate is bound and its projection throws, the bus sends no frame (a live feed fails closed)', async () => {
  const admission: Admission = {
    ...recordingAdmission(),
    inventory: () => {
      throw new Error('an undetermined device');
    },
  };
  const { host, published } = await boot(admission);
  try {
    const decision = await host.dispatcher.upgrade(request('GET', '/v1/bus'));
    if (decision.outcome !== 'accepted') throw new Error('upgrade');
    const feed = downstream();
    const handler = await decision.attach(feed.port);
    await handler.open();
    published['board']?.(Moved, { card: 'F1' });
    published['voice']?.(Secret, { text: 'never shown' });
    // a core plugin's event is held back too: the old fallback (core pieces only) would have sent this one
    published['gate']?.(Alarm, { level: 'high' });
    await flush();
    expect(feed.sent).toEqual([]);
    handler.close();
  } finally {
    await host.stop();
  }
});
