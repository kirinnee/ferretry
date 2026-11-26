import { afterEach, describe, expect, test } from 'bun:test';
import type { PluginSocket, PluginSocketListeners } from '@ferretry/kernel/manifest';
import type { ReactElement } from 'react';
import {
  type StreamSnapshot,
  UNIT_MS,
  UNIT_SAMPLES,
  SPEAK_FRAME_BYTES,
  decodeLineFrame,
  encodeReplyDownlinkUnit,
} from '../../../contract/index.ts';
import { VoiceModeSlot } from '../../../app/components/voice-mode-panel.tsx';
import { ReadAloudProvider } from '../../../app/hooks/use-read-aloud.ts';
import type { MicSource, ReplyPlayer } from '../../../app/lib/stream/voice-stream.ts';
import { BARGE_IN_MS } from '../../../app/lib/voice-mode/barge-in.ts';
import { createVoiceModeStore } from '../../../app/lib/voice-mode/voice-mode-store.ts';
import { createReadAloud } from '../../../app/lib/voice-chat/read-aloud.ts';
import type { SpeakerPort } from '../../../app/lib/voice-chat/ports.ts';
import { interact, type Mounted, mount } from '../../support/app/dom.ts';

/**
 * V4 in the panel: a `<voice>` line the ferret finishes mid-turn plays at once through the machine's voice, a stale progress
 * line is taken back, the person can talk over it, and the whole voice-mode session keeps ONE name across a reconnect.
 */

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

const NONCE = 'dddddddddddddddd';
const unit = (patch: Partial<StreamSnapshot> = {}, pcm = new Int16Array(0)): Uint8Array =>
  encodeReplyDownlinkUnit({ v: 1, state: 'listening', nonce: NONCE, turn: 0, reply: 'ready', ...patch }, pcm);
const SPEECH = new Int16Array(UNIT_SAMPLES).fill(7_000);
const QUIET = new Int16Array(UNIT_SAMPLES).fill(60);

function rig() {
  const sent: (string | Uint8Array)[] = [];
  const starts: Record<string, unknown>[] = [];
  let listeners!: PluginSocketListeners;
  let onUnit: ((pcm: Int16Array) => void) | undefined;
  const played: Int16Array[] = [];
  let stops = 0;
  const fakePlayer: ReplyPlayer = {
    play: pcm => void played.push(pcm),
    stop: () => {
      stops += 1;
    },
    remainingMs: () => 0,
    close: () => undefined,
  };
  const socket: PluginSocket = {
    send: frame => {
      sent.push(frame);
      if (typeof frame === 'string' && frame.startsWith('{"t":"start"')) starts.push(JSON.parse(frame));
    },
    close: () => undefined,
  };
  const client = {
    socket: (_route: string, _params: unknown, given: PluginSocketListeners) => {
      listeners = given;
      return socket;
    },
  };
  const mic: MicSource = {
    start: async next => {
      onUnit = next;
    },
    stop: () => undefined,
  };
  const device: SpeakerPort = {
    supported: true,
    voices: () => [],
    unlock: () => undefined,
    speak: () => undefined,
    stop: () => undefined,
  };
  return {
    sent,
    starts,
    played,
    stops: () => stops,
    client,
    mic,
    fakePlayer,
    controller: createReadAloud({ speaker: device, language: () => 'en-US' }),
    store: createVoiceModeStore(),
    listeners: () => listeners,
    pcm: (pcm: Int16Array) => onUnit?.(pcm),
    lineFrames: () =>
      sent
        .filter((frame): frame is string => typeof frame === 'string' && frame.length === SPEAK_FRAME_BYTES)
        .map(frame => decodeLineFrame(frame)),
  };
}

const tree = (r: ReturnType<typeof rig>, client = r.client): ReactElement => (
  <ReadAloudProvider controller={r.controller}>
    <VoiceModeSlot
      client={client}
      createMic={() => r.mic}
      createPlayer={() => r.fakePlayer}
      fallback={<textarea data-composer="" />}
      ferretId="ferret-1"
      store={r.store}
      turn={{ state: 'working', live: true }}
    />
  </ReadAloudProvider>
);

const settle = async (): Promise<void> => {
  await interact(() => new Promise(resolve => setTimeout(resolve, 0)));
};
const q = (selector: string): Element | null => mounted?.container.querySelector(selector) ?? null;
const talk = async (r: ReturnType<typeof rig>, pcm: Int16Array, count: number): Promise<void> => {
  await interact(() => {
    for (let index = 0; index < count; index += 1) r.pcm(pcm);
  });
};

async function begin(r: ReturnType<typeof rig>): Promise<void> {
  mounted = await mount(tree(r));
  await interact(() => r.store.start('ferret-1', 'desk'));
  await interact(() => r.listeners().onOpen?.());
  await settle();
  await interact(() => r.listeners().onFrame?.(unit()));
  await talk(r, QUIET, 50);
}

describe('V4: voice mode speaks while the ferret works', () => {
  test('a line finished mid-turn goes to the machine at once, behind nothing, with no reading started', async () => {
    const r = rig();
    await begin(r);
    const sink = r.store.live('ferret-1');
    expect(sink).toBeDefined();
    await interact(
      () =>
        void sink?.say({ id: 'Looking at the build.', text: 'Looking at the build.', kind: 'first' }, () => undefined),
    );
    expect(r.lineFrames()).toEqual([{ t: 'speak', id: 0, text: 'Looking at the build.' }]);
    expect(r.controller.getState().status).not.toBe('reading');
    await interact(() =>
      r.listeners().onFrame?.(unit({ audio: { id: 0, samples: 100, last: false } }, new Int16Array(100).fill(3))),
    );
    expect(r.played).toHaveLength(1);
    expect(q('[data-voice-mode]')?.getAttribute('data-reply-voice')).toBe('machine');
    expect(q('[data-voice-mode-status]')?.textContent).toContain('Talk any time to interrupt');
  });

  test('a waiting line the ferret is KNOWN to have worked past is taken back when a newer one is behind it; the first line and the rest are not', async () => {
    const r = rig();
    await begin(r);
    const sink = r.store.live('ferret-1');
    const none = (): void => undefined;
    await interact(() => {
      sink?.say({ id: 'First.', text: 'First.', kind: 'first' }, none);
      sink?.say({ id: 'Step one.', text: 'Step one.', kind: 'line' }, none);
      sink?.say({ id: 'Step two.', text: 'Step two.', kind: 'line' }, none);
      sink?.say({ id: 'All done.', text: 'All done.', kind: 'line' }, none);
    });
    // Arrival alone takes nothing back: nobody said any of them was progress.
    expect(r.lineFrames().filter(frame => frame.t === 'drop')).toEqual([]);
    await interact(() => sink?.outdate(['First.', 'Step one.', 'Step two.']));
    expect(r.lineFrames().filter(frame => frame.t === 'drop')).toEqual([
      { t: 'drop', id: 1 },
      { t: 'drop', id: 2 },
    ]);
  });

  test('closing the panel with a line still waiting leaves no poll running and tells the reader it was not played', async () => {
    const r = rig();
    await begin(r);
    const told: string[] = [];
    await interact(
      () =>
        void r.store
          .live('ferret-1')
          ?.say({ id: 'First.', text: 'First.', kind: 'first' }, outcome => told.push(outcome)),
    );
    await mounted?.unmount();
    mounted = null;
    expect(told).toEqual(['unplayed']);
  });

  test('talking over a live line stops the sound at 300 ms and hushes the machine', async () => {
    const r = rig();
    await begin(r);
    await interact(
      () =>
        void r.store
          .live('ferret-1')
          ?.say({ id: 'A long line to talk over.', text: 'A long line to talk over.', kind: 'first' }, () => undefined),
    );
    await interact(() =>
      r.listeners().onFrame?.(unit({ audio: { id: 0, samples: 100, last: false } }, new Int16Array(100).fill(3))),
    );
    const stopsBefore = r.stops();
    const needed = Math.ceil(BARGE_IN_MS / UNIT_MS);
    await talk(r, SPEECH, needed - 1);
    expect(r.stops()).toBe(stopsBefore);
    await talk(r, SPEECH, 1);
    expect(r.stops()).toBeGreaterThan(stopsBefore);
    expect(r.lineFrames().at(-1)).toEqual({ t: 'hush' });
    expect(q('[data-voice-mode-status]')?.textContent).toContain('Stopped');
  });

  test('a machine without the reply voice takes no live line, so the reading at the end of the turn keeps it', async () => {
    const r = rig();
    mounted = await mount(tree(r));
    await interact(() => r.store.start('ferret-1', 'desk'));
    await interact(() => r.listeners().onOpen?.());
    await interact(() => r.listeners().onFrame?.(unit({ reply: 'absent' })));
    expect(
      r.store
        .live('ferret-1')
        ?.say({ id: 'Nobody can say this.', text: 'Nobody can say this.', kind: 'first' }, () => undefined),
    ).toBe(false);
    expect(r.lineFrames()).toEqual([]);
  });

  test('ending voice mode takes the voice back from live lines', async () => {
    const r = rig();
    await begin(r);
    expect(r.store.live('ferret-1')).toBeDefined();
    await interact(() => r.store.end('ferret-1'));
    expect(r.store.live('ferret-1')).toBeUndefined();
  });
});

describe('V1: the voice-mode session is named once and the stream says that name every time it opens', () => {
  test('a stream that reopens inside the session (a new client, a dropped carrier) carries the same name; a new voice mode, a new one', async () => {
    const r = rig();
    await begin(r);
    const session = r.store.get('ferret-1').session;
    expect(r.starts[0]).toMatchObject({ purpose: 'chat', ferretId: 'ferret-1', session });
    // The carrier changed under the same voice mode: the panel opens another stream.
    const second = { ...r.client };
    await mounted?.render(tree(r, second));
    await interact(() => r.listeners().onOpen?.());
    expect(r.starts).toHaveLength(2);
    expect(r.starts[1]?.session).toBe(session);
    await interact(() => r.store.end('ferret-1'));
    await interact(() => r.store.start('ferret-1', 'desk'));
    await interact(() => r.listeners().onOpen?.());
    expect(r.starts.at(-1)?.session).not.toBe(session);
  });
});
