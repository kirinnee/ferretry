import { afterEach, describe, expect, test } from 'bun:test';
import type { PluginSocket, PluginSocketListeners } from '@ferretry/kernel/manifest';
import type { ReactElement } from 'react';
import {
  type StreamSnapshot,
  UNIT_MS,
  UNIT_SAMPLES,
  SPEAK_FRAME_BYTES,
  decodeLineFrame,
  decodeUplinkUnit,
  encodeReplyDownlinkUnit,
} from '../../../contract/index.ts';
import { VoiceModeSlot } from '../../../app/components/voice-mode-panel.tsx';
import { ReadAloudProvider } from '../../../app/hooks/use-read-aloud.ts';
import { type MicSource, type ReplyPlayer, VOICE_STREAM_ROUTE } from '../../../app/lib/stream/voice-stream.ts';
import { BARGE_IN_MS } from '../../../app/lib/voice-mode/barge-in.ts';
import { createVoiceModeStore } from '../../../app/lib/voice-mode/voice-mode-store.ts';
import { createReadAloud } from '../../../app/lib/voice-chat/read-aloud.ts';
import type { SpeakerPort, SpeakRequest } from '../../../app/lib/voice-chat/ports.ts';
import { interact, type Mounted, mount } from '../../support/app/dom.ts';

/**
 * Voice mode speaks a reply with the machine's reply voice and lets the person talk over it. The whole page half is real
 * (panel, stream client, machine speaker, the read-aloud controller, the barge-in detector); the machine, the microphone,
 * the sound output and the device's voice are fakes. The numbers it proves: speech injected mid-reply stops the sound at the
 * unit that completes ${BARGE_IN_MS} ms of it, the machine is hushed, and the microphone stays open under the machine's
 * voice but not under the device's.
 */

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

const NONCE = 'cccccccccccccccc';
const unit = (patch: Partial<StreamSnapshot> = {}, pcm = new Int16Array(0)): Uint8Array =>
  encodeReplyDownlinkUnit({ v: 1, state: 'listening', nonce: NONCE, turn: 0, reply: 'ready', ...patch }, pcm);

const QUIET = new Int16Array(UNIT_SAMPLES).fill(60);
const SPEECH = new Int16Array(UNIT_SAMPLES).fill(7_000);

function rig() {
  const sent: (string | Uint8Array)[] = [];
  let listeners!: PluginSocketListeners;
  let onUnit: ((pcm: Int16Array) => void) | undefined;
  const played: Int16Array[] = [];
  const player = { stops: 0, closed: 0 };
  const fakePlayer: ReplyPlayer = {
    // The person has heard half of what was played, all of it line 0.
    position: () =>
      played.length === 0 ? undefined : { id: 0, samples: played.reduce((all, pcm) => all + pcm.length, 0) / 2 },
    play: pcm => void played.push(pcm),
    stop: () => {
      player.stops += 1;
    },
    remainingMs: () => 0,
    close: () => {
      player.closed += 1;
    },
  };
  const socket: PluginSocket = { send: frame => void sent.push(frame), close: () => undefined };
  const client = {
    socket: (route: string, _params: unknown, given: PluginSocketListeners) => {
      expect(route).toBe(VOICE_STREAM_ROUTE);
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
  const deviceSaid: SpeakRequest[] = [];
  let deviceStops = 0;
  const device: SpeakerPort = {
    supported: true,
    voices: () => [{ id: 'd', name: 'Device', lang: 'en-US', local: true, isDefault: true }],
    unlock: () => undefined,
    speak: request => void deviceSaid.push(request),
    stop: () => {
      deviceStops += 1;
    },
  };
  const controller = createReadAloud({ speaker: device, language: () => 'en-US' });
  const store = createVoiceModeStore();
  return {
    sent,
    played,
    player,
    controller,
    store,
    client,
    mic,
    fakePlayer,
    deviceSaid,
    deviceStops: () => deviceStops,
    listeners: () => listeners,
    pcm: (pcm: Int16Array) => onUnit?.(pcm),
    uplinks: () => sent.filter((frame): frame is Uint8Array => typeof frame !== 'string').map(decodeUplinkUnit),
    lineFrames: () =>
      sent
        .filter((frame): frame is string => typeof frame === 'string' && frame.length === SPEAK_FRAME_BYTES)
        .map(frame => decodeLineFrame(frame)),
  };
}

const tree = (r: ReturnType<typeof rig>): ReactElement => (
  <ReadAloudProvider controller={r.controller}>
    <VoiceModeSlot
      client={r.client}
      createMic={() => r.mic}
      createPlayer={() => r.fakePlayer}
      fallback={<textarea data-composer="" />}
      ferretId="ferret-1"
      store={r.store}
      turn={{ state: 'your-turn', live: true }}
    />
  </ReadAloudProvider>
);

const settle = async (): Promise<void> => {
  await interact(() => new Promise(resolve => setTimeout(resolve, 0)));
};
const q = (selector: string): Element | null => mounted?.container.querySelector(selector) ?? null;

/** `count` units of the microphone, in one act. */
const talk = async (r: ReturnType<typeof rig>, pcm: Int16Array, count: number): Promise<void> => {
  await interact(() => {
    for (let index = 0; index < count; index += 1) r.pcm(pcm);
  });
};

/** Voice mode on, the stream open, the machine's reply voice ready, and a quiet room learned. */
async function begin(r: ReturnType<typeof rig>, reply: StreamSnapshot['reply'] = 'ready'): Promise<void> {
  mounted = await mount(tree(r));
  await interact(() => r.store.start('ferret-1', 'desk'));
  await interact(() => r.listeners().onOpen?.());
  await settle();
  await interact(() => r.listeners().onFrame?.(unit({ reply })));
  await talk(r, QUIET, 50);
}

const REPLY = '<voice>Let me check.</voice>';

describe('voice mode speaks with the machine and can be talked over', () => {
  test('the stream asks for the machine voice, and a reply is sent to it line by line', async () => {
    const r = rig();
    await begin(r);
    const start = r.sent.find(
      (frame): frame is string => typeof frame === 'string' && frame.startsWith('{"t":"start"'),
    );
    expect(JSON.parse(start ?? '{}')).toMatchObject({ purpose: 'chat', ferretId: 'ferret-1', reply: 'machine' });
    await interact(() => r.controller.read('k', REPLY));
    expect(r.lineFrames()).toEqual([{ t: 'speak', id: 0, text: 'Let me check.' }]);
    expect(r.deviceSaid).toEqual([]);
    await interact(() =>
      r.listeners().onFrame?.(unit({ audio: { id: 0, samples: 100, last: false } }, new Int16Array(100).fill(3))),
    );
    expect(r.played).toHaveLength(1);
    expect(q('[data-voice-mode]')?.getAttribute('data-reply-voice')).toBe('machine');
    expect(q('[data-voice-mode-status]')?.textContent).toContain('Talk any time to interrupt');
  });

  test('the microphone stays open under the machine voice, and speech over it stops the sound at 300 ms and hushes the machine', async () => {
    const r = rig();
    await begin(r);
    await interact(() => r.controller.read('k', REPLY));
    await interact(() =>
      r.listeners().onFrame?.(unit({ audio: { id: 0, samples: 100, last: false } }, new Int16Array(100).fill(3))),
    );
    const stopsBefore = r.player.stops;
    const unitsBefore = r.uplinks().length;
    // Less than 300 ms of speech: the reply carries on.
    const needed = Math.ceil(BARGE_IN_MS / UNIT_MS);
    await talk(r, SPEECH, needed - 1);
    expect(r.controller.getState().status).toBe('reading');
    expect(r.player.stops).toBe(stopsBefore);
    // The unit that completes 300 ms stops it, in that very unit.
    await talk(r, SPEECH, 1);
    expect(r.controller.getState().status).toBe('stopped');
    expect(r.player.stops).toBeGreaterThan(stopsBefore);
    expect(r.lineFrames().at(-1)).toEqual({ t: 'hush', cut: { id: 0, samples: 50 } });
    expect(needed * UNIT_MS).toBeLessThanOrEqual(320);
    // What the machine heard is the person's voice, untouched: it sends it after the pause as usual.
    const heard = r.uplinks().slice(unitsBefore);
    expect(heard).toHaveLength(needed);
    expect(heard.every(entry => entry.pcm[0] === 7_000)).toBe(true);
    expect(q('[data-voice-mode-status]')?.textContent).toContain('Stopped');
    // Sound of the line that was hushed that still arrives is not played.
    const playedBefore = r.played.length;
    await interact(() =>
      r.listeners().onFrame?.(unit({ audio: { id: 0, samples: 100, last: true } }, new Int16Array(100).fill(3))),
    );
    expect(r.played).toHaveLength(playedBefore);
  });

  test('speech while no reply is playing never stops anything', async () => {
    const r = rig();
    await begin(r);
    await talk(r, SPEECH, 30);
    expect(r.player.stops).toBe(0);
    expect(r.lineFrames()).toEqual([]);
  });

  test('a person who muted themselves cannot interrupt (nothing of the room leaves, and nothing is heard here)', async () => {
    const r = rig();
    await begin(r);
    await interact(() => r.controller.read('k', REPLY));
    await interact(() => (q('[data-voice-mode-mute]') as HTMLButtonElement).click());
    await talk(r, SPEECH, 30);
    expect(r.controller.getState().status).toBe('reading');
    expect(
      r
        .uplinks()
        .slice(-5)
        .every(entry => entry.pcm.every(sample => sample === 0)),
    ).toBe(true);
  });

  test('a machine without the reply voice: the device voice reads the same words, and the microphone is muted under it', async () => {
    const r = rig();
    await begin(r, 'absent');
    await interact(() => r.controller.read('k', REPLY));
    expect(r.deviceSaid).toHaveLength(1);
    expect(r.deviceSaid[0]?.segments).toEqual(['Let me check.']);
    expect(r.lineFrames()).toEqual([]);
    expect(q('[data-voice-mode]')?.getAttribute('data-reply-voice')).toBe('device');
    await talk(r, SPEECH, 20);
    // Zero samples on the wire, and the device's reading is not talked over.
    expect(
      r
        .uplinks()
        .slice(-10)
        .every(entry => entry.pcm.every(sample => sample === 0)),
    ).toBe(true);
    expect(r.controller.getState().status).toBe('reading');
    expect(q('[data-voice-mode-status]')?.textContent).toContain('microphone is off');
  });

  test('ending voice mode stops a reply that is being spoken and gives the device voice back', async () => {
    const r = rig();
    await begin(r);
    await interact(() => r.controller.read('k', REPLY));
    await interact(() => r.store.end('ferret-1'));
    expect(r.controller.getState().status).toBe('stopped');
    expect(r.player.closed).toBe(1);
    await interact(() => r.controller.read('k2', REPLY));
    expect(r.deviceSaid).toHaveLength(1);
  });
});
