import { afterEach, describe, expect, test } from 'bun:test';
import type { PluginSocket, PluginSocketListeners } from '@ferretry/kernel/manifest';
import type { ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { type StreamSnapshot, UNIT_SAMPLES, decodeUplinkUnit, encodeDownlinkUnit } from '../../../contract/index.ts';
import { VoiceModeSlot } from '../../../app/components/voice-mode-panel.tsx';
import { ReadAloudProvider } from '../../../app/hooks/use-read-aloud.ts';
import { type MicSource, VOICE_STREAM_ROUTE } from '../../../app/lib/stream/voice-stream.ts';
import { createVoiceModeStore } from '../../../app/lib/voice-mode/voice-mode-store.ts';
import { IDLE, type ReadAloudController, type ReadAloudState } from '../../../app/lib/voice-chat/read-aloud.ts';
import { interact, type Mounted, mount } from '../../support/app/dom.ts';

/**
 * Voice mode's panel in front of the composer (`conversation.composer`), against a fake machine: the composer is hidden
 * but never dropped, one chat stream opens for THIS ferret, the machine's words and state are shown, mute is zero samples,
 * a reply being read mutes the microphone, End restores the composer, and a refusal leaves a sentence.
 */

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

const NONCE = 'aaaaaaaaaaaaaaaa';
const unit = (patch: Partial<StreamSnapshot> = {}): Uint8Array =>
  encodeDownlinkUnit({ v: 1, state: 'listening', nonce: NONCE, turn: 0, ...patch });

const rig = () => {
  const sent: (string | Uint8Array)[] = [];
  const closes: (number | undefined)[] = [];
  let listeners!: PluginSocketListeners;
  let onUnit: ((pcm: Int16Array) => void) | undefined;
  let micStops = 0;
  let opened = 0;
  const socket: PluginSocket = {
    send: frame => void sent.push(frame),
    close: code => void closes.push(code),
  };
  const client = {
    socket: (route: string, _params: unknown, given: PluginSocketListeners) => {
      expect(route).toBe(VOICE_STREAM_ROUTE);
      opened += 1;
      listeners = given;
      return socket;
    },
  };
  const mic: MicSource = {
    start: async next => {
      onUnit = next;
    },
    stop: () => {
      micStops += 1;
    },
  };
  let reading: ReadAloudState = IDLE;
  const heard = new Set<() => void>();
  const reader = {
    supported: true,
    getState: () => reading,
    subscribe: (listener: () => void) => {
      heard.add(listener);
      return () => heard.delete(listener);
    },
  } as unknown as ReadAloudController;
  const createMic = () => mic;
  const store = createVoiceModeStore();
  return {
    sent,
    closes,
    store,
    client,
    reader,
    createMic,
    listeners: () => listeners,
    opened: () => opened,
    micStops: () => micStops,
    pcm: (value: number) => onUnit?.(new Int16Array(UNIT_SAMPLES).fill(value)),
    setReading: async (on: boolean) => {
      reading = on ? { ...IDLE, status: 'reading', key: 'k' } : IDLE;
      await interact(() => {
        for (const listener of [...heard]) listener();
      });
    },
    uplinks: () => sent.filter((frame): frame is Uint8Array => typeof frame !== 'string').map(decodeUplinkUnit),
  };
};

const tree = (
  r: ReturnType<typeof rig>,
  turn: { state: 'working' | 'your-turn' | 'needs-input' | null; live: boolean } = { state: 'your-turn', live: true },
): ReactElement => (
  <ReadAloudProvider controller={r.reader}>
    <VoiceModeSlot
      client={r.client}
      createMic={r.createMic}
      fallback={<textarea data-composer="" />}
      ferretId="ferret-1"
      store={r.store}
      turn={turn}
    />
  </ReadAloudProvider>
);

const settle = async (): Promise<void> => {
  await interact(() => new Promise(resolve => setTimeout(resolve, 0)));
};
const q = (selector: string): Element | null => mounted?.container.querySelector(selector) ?? null;
const text = (selector: string): string => q(selector)?.textContent ?? '';

const start = async (r: ReturnType<typeof rig>): Promise<void> => {
  await interact(() => r.store.start('ferret-1', 'desk'));
  await interact(() => r.listeners().onOpen?.());
  await settle();
};

describe('voice mode in front of the composer', () => {
  test('off: the composer is drawn as it was and nothing opens', async () => {
    const r = rig();
    mounted = await mount(tree(r));
    expect(q('[data-composer]')).not.toBeNull();
    expect(q('[data-voice-mode-composer]')?.getAttribute('data-voice-mode-composer')).toBe('shown');
    expect(q('[data-voice-mode]')).toBeNull();
    expect(r.opened()).toBe(0);
  });

  test('on: the composer is hidden but the very same one stays mounted, and one chat stream opens for this ferret', async () => {
    const r = rig();
    mounted = await mount(tree(r));
    const box = q('[data-composer]') as HTMLTextAreaElement;
    box.value = 'half a thought';
    await start(r);
    expect(r.opened()).toBe(1);
    expect(JSON.parse(r.sent[0] as string)).toEqual({ t: 'start', v: 1, purpose: 'chat', ferretId: 'ferret-1' });
    expect(q('[data-voice-mode]')).not.toBeNull();
    expect(q('[data-composer]')).toBe(box);
    expect((q('[data-voice-mode-composer]') as HTMLElement).style.display).toBe('none');
    expect(box.value).toBe('half a thought');
  });

  test('End closes the stream, stops the microphone, tells the machine, and gives the same composer back with its draft', async () => {
    const r = rig();
    mounted = await mount(tree(r));
    const box = q('[data-composer]') as HTMLTextAreaElement;
    box.value = 'keep me';
    await start(r);
    await interact(() => (q('[data-voice-mode-end]') as HTMLButtonElement).click());
    expect(r.uplinks().at(-1)?.control).toBe('end');
    expect(r.closes).toEqual([1000]);
    expect(r.micStops()).toBe(1);
    expect(r.store.get('ferret-1').active).toBe(false);
    expect(q('[data-voice-mode]')).toBeNull();
    expect(q('[data-composer]')).toBe(box);
    expect(box.value).toBe('keep me');
    expect(q('[data-voice-mode-notice]')).toBeNull();
  });

  test("shows the machine's state and the words it hears, and Working while the ferret works", async () => {
    const r = rig();
    mounted = await mount(tree(r));
    await start(r);
    expect(text('[data-voice-mode-status]')).toContain('Loading speech on desk');
    await interact(() => r.listeners().onFrame(unit()));
    expect(text('[data-voice-mode-status]')).toContain('Listening');
    await interact(() =>
      r.listeners().onFrame(
        unit({
          state: 'hearing',
          turn: 1,
          words: { turn: 1, rev: 0, offset: 0, total: 9, text: 'fix tests', final: false },
        }),
      ),
    );
    expect(text('[data-voice-mode-status]')).toContain('Hearing you');
    expect(text('[data-voice-mode-words]')).toBe('fix tests');
    expect(q('[data-voice-mode-words]')?.getAttribute('data-final')).toBe('false');
    await interact(() => r.listeners().onFrame(unit({ turn: 1, last: { turn: 1, outcome: 'sent' } })));
    expect(text('[data-voice-mode-outcome]')).toBe('Sent.');
    await mounted.render(tree(r, { state: 'working', live: true }));
    expect(text('[data-voice-mode-status]')).toContain('Working');
    // A turn the chat did not read live from the daemon is never claimed as working.
    await mounted.render(tree(r, { state: 'working', live: false }));
    expect(text('[data-voice-mode-status]')).toContain('Listening');
  });

  test('Mute uploads zero samples and says so; Unmute brings the audio back', async () => {
    const r = rig();
    mounted = await mount(tree(r));
    await start(r);
    await interact(() => (q('[data-voice-mode-mute]') as HTMLButtonElement).click());
    r.pcm(900);
    r.pcm(900);
    const muted = r.uplinks().slice(-2);
    expect(muted[0]?.control).toBe('muted');
    expect([...(muted[1]?.pcm ?? [1])].every(sample => sample === 0)).toBe(true);
    expect(text('[data-voice-mode-status]')).toContain('Muted');
    await interact(() => (q('[data-voice-mode-mute]') as HTMLButtonElement).click());
    r.pcm(900);
    r.pcm(900);
    const back = r.uplinks().slice(-2);
    expect(back[0]?.control).toBe('unmuted');
    expect(back[1]?.pcm[0]).toBe(900);
  });

  test('while a reply is read aloud the microphone is muted (zero samples), and it returns when the reading ends', async () => {
    const r = rig();
    mounted = await mount(tree(r));
    await start(r);
    await r.setReading(true);
    r.pcm(700);
    r.pcm(700);
    expect(r.uplinks().slice(-2)[0]?.control).toBe('muted');
    expect([...(r.uplinks().at(-1)?.pcm ?? [1])].every(sample => sample === 0)).toBe(true);
    expect(text('[data-voice-mode-status]')).toContain('Reading the reply');
    await r.setReading(false);
    r.pcm(700);
    expect(r.uplinks().at(-1)?.control).toBe('unmuted');
    expect(r.uplinks().at(-1)?.pcm[0]).toBe(700);
  });

  test("a refusal in the machine's own sentence ends voice mode, gives the composer back and leaves the sentence", async () => {
    const r = rig();
    mounted = await mount(tree(r));
    await start(r);
    await interact(() =>
      r
        .listeners()
        .onFrame(unit({ error: { code: 'fleet_not_granted', message: 'Voice chat needs fleet permission.' } })),
    );
    await interact(() => r.listeners().onClose('voice chat needs the fleet permission as well', 4403));
    expect(r.store.get('ferret-1').active).toBe(false);
    expect(q('[data-voice-mode]')).toBeNull();
    expect(text('[data-voice-mode-notice]')).toContain('Voice chat needs fleet permission.');
    expect((q('[data-voice-mode-composer]') as HTMLElement).style.display).toBe('contents');
    await interact(() => (q('[data-voice-mode-notice] button') as HTMLButtonElement).click());
    expect(q('[data-voice-mode-notice]')).toBeNull();
  });

  test('a close with no sentence still says why, by its code, naming the machine', async () => {
    const r = rig();
    mounted = await mount(tree(r));
    await start(r);
    await interact(() => r.listeners().onClose('the device went silent', 4408));
    expect(text('[data-voice-mode-notice]')).toContain('desk stopped hearing this device');
  });

  test.each([
    [4429, 'desk is already serving voice chats.'],
    [4450, 'desk could not keep up, so voice mode ended.'],
    [4401, 'This device may no longer use voice on this machine.'],
    [4403, 'Voice mode also needs permission to talk to ferrets on this machine.'],
    [1011, 'Lost desk (closed 1011). Voice mode ended.'],
  ])('a close with code %i and no sentence of its own is said in words', async (code, sentence) => {
    const r = rig();
    mounted = await mount(tree(r));
    await start(r);
    await interact(() => r.listeners().onClose('closed', code));
    expect(text('[data-voice-mode-notice]')).toContain(sentence);
  });

  test('a microphone that is refused ends voice mode with what to do', async () => {
    const r = rig();
    const refused: MicSource = {
      start: async () => {
        throw new Error('denied');
      },
      stop: () => undefined,
    };
    const trial = { ...r, createMic: () => refused };
    mounted = await mount(tree(trial));
    await interact(() => r.store.start('ferret-1', 'desk'));
    await interact(() => r.listeners().onOpen?.());
    await settle();
    expect(text('[data-voice-mode-notice]')).toContain('microphone could not be opened');
    expect(r.store.get('ferret-1').active).toBe(false);
  });

  test('a browser with no way to open a stream says so and keeps the composer', async () => {
    const r = rig();
    mounted = await mount(
      <VoiceModeSlot
        client={{ socket: undefined }}
        fallback={<textarea data-composer="" />}
        ferretId="ferret-1"
        store={r.store}
        turn={undefined}
      />,
    );
    await interact(() => r.store.start('ferret-1', 'desk'));
    await settle();
    expect(text('[data-voice-mode-notice]')).toContain('cannot open a voice stream');
    expect(q('[data-composer]')).not.toBeNull();
  });

  test('leaving the chat while voice mode is on ends it and closes the stream', async () => {
    const r = rig();
    mounted = await mount(tree(r));
    await start(r);
    await mounted.unmount();
    mounted = null;
    expect(r.store.get('ferret-1').active).toBe(false);
    expect(r.micStops()).toBe(1);
  });
});

describe('voice mode on a server render', () => {
  test('a page drawn on the server (no microphone, no stream) shows the composer, never the panel', () => {
    const r = rig();
    r.store.start('ferret-1', 'desk');
    const html = renderToString(tree(r));
    expect(html).toContain('data-composer');
    expect(html).not.toContain('data-voice-mode="on"');
  });
});
