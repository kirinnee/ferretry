import { afterEach, describe, expect, test } from 'bun:test';
import type { PluginSocket, PluginSocketListeners } from '@ferretry/kernel/manifest';
import type { ReactElement } from 'react';
import { type StreamSnapshot, encodeDownlinkUnit } from '../../../contract/index.ts';
import { PhoneSession } from '../../../app/components/voice-mode-phone.tsx';
import { VoiceModeSlot } from '../../../app/components/voice-mode-panel.tsx';
import { ReadAloudProvider } from '../../../app/hooks/use-read-aloud.ts';
import type { CaptureMonitor, MicMeter, MicMeterPort } from '../../../app/lib/stt/level-monitor.ts';
import { DEFAULT_STT_SETTINGS, type SttSettings } from '../../../app/lib/stt/stt-settings.ts';
import type { MicSource } from '../../../app/lib/stream/voice-stream.ts';
import {
  keptOnPhoneBanner,
  lostBanner,
  PAUSE_MS,
  PauseWatcher,
  shouldFallBack,
  SPEECH_LEVEL,
  unreachableBanner,
} from '../../../app/lib/voice-mode/phone-loop.ts';
import { sendIdOf } from '../../../app/lib/voice-mode/phone-send.ts';
import { createVoiceModeStore } from '../../../app/lib/voice-mode/voice-mode-store.ts';
import { IDLE, type ReadAloudController, type ReadAloudState } from '../../../app/lib/voice-chat/read-aloud.ts';
import { daemonConnection } from '../../../app/shell-voice.ts';
import { fakeRecognitionProvider } from '../../support/app/browser-recognition.ts';
import { interact, type Mounted, mount } from '../../support/app/dom.ts';

/**
 * Voice mode on the phone's own engine, the fallback: the pause rules, when a lost machine hands over, and the panel that
 * carries on: a banner that says why, a take that listens, a pause that sends `(voice) <words>` once with a stable id, a
 * refused send that says so, and the same Mute and End.
 */

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

describe('PauseWatcher', () => {
  test('quiet before anyone speaks is not a pause', () => {
    const watcher = new PauseWatcher();
    expect(watcher.feed(0, 0)).toBe(false);
    expect(watcher.feed(0, PAUSE_MS * 10)).toBe(false);
    expect(watcher.heardSpeech).toBe(false);
  });

  test('speech then a full pause of quiet ends the take once, and the next take starts over', () => {
    const watcher = new PauseWatcher();
    expect(watcher.feed(SPEECH_LEVEL * 3, 0)).toBe(false);
    expect(watcher.feed(0, 100)).toBe(false);
    expect(watcher.feed(0, 100 + PAUSE_MS - 1)).toBe(false);
    expect(watcher.feed(0, 100 + PAUSE_MS)).toBe(true);
    expect(watcher.heardSpeech).toBe(false);
    expect(watcher.feed(0, 100 + PAUSE_MS * 3)).toBe(false);
  });

  test('speech resuming inside the pause cancels it', () => {
    const watcher = new PauseWatcher();
    watcher.feed(SPEECH_LEVEL * 3, 0);
    watcher.feed(0, 100);
    expect(watcher.feed(SPEECH_LEVEL * 3, 1_000)).toBe(false);
    expect(watcher.feed(0, 1_100)).toBe(false);
    expect(watcher.feed(0, 1_100 + PAUSE_MS - 1)).toBe(false);
    expect(watcher.feed(0, 1_100 + PAUSE_MS)).toBe(true);
  });

  test('a level that is not a number is quiet, never speech', () => {
    const watcher = new PauseWatcher();
    expect(watcher.feed(Number.NaN, 0)).toBe(false);
    expect(watcher.heardSpeech).toBe(false);
  });
});

describe('when a lost machine hands over to the phone', () => {
  test('a normal end and a refused permission do not; every failure does', () => {
    expect(shouldFallBack({ code: 1000 })).toBe(false);
    expect(shouldFallBack({ code: 4401 })).toBe(false);
    expect(shouldFallBack({ code: 4403 })).toBe(false);
    for (const code of [4408, 4429, 4450, 4400, 1011, 1006, 1008, undefined]) {
      expect(shouldFallBack({ code })).toBe(true);
    }
  });

  test('the banner says why, in words, naming the machine, and the machine’s own sentence when it gave one', () => {
    expect(lostBanner('desk', 4408, undefined)).toContain('desk stopped hearing this phone');
    expect(lostBanner('desk', 4429, undefined)).toContain('desk is already serving voice chats');
    expect(lostBanner('desk', 4450, undefined)).toContain('desk could not keep up');
    expect(lostBanner('desk', 1006, undefined)).toContain('Lost desk');
    expect(lostBanner('desk', 1006, 'Speech could not start on this machine.')).toContain(
      'Speech could not start on this machine.',
    );
    for (const banner of [lostBanner('desk', 1006, undefined), unreachableBanner('desk'), keptOnPhoneBanner])
      expect(banner).toContain('phone');
  });
});

// ─── the panel on the phone's engine ─────────────────────────────────────────────────────────────────────────────

const daemon = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'http://127.0.0.1:1', deviceId: 'token-a' });
const settings = (patch: Partial<SttSettings> = {}): SttSettings => ({
  ...DEFAULT_STT_SETTINGS,
  engine: 'browser',
  enhancement: false,
  ...patch,
});

interface SentCall {
  readonly route: string;
  readonly ferretId: string | undefined;
  readonly message: string;
  readonly sendId: string;
  readonly header: string | undefined;
}

/** One phone: a recognition engine, a microphone level the test sets, a clock the test moves, and the send route. */
const phone = () => {
  const provider = fakeRecognitionProvider({ endsOnStop: true });
  let level = 0;
  let clock = 0;
  const analyser = {
    fftSize: 32,
    smoothingTimeConstant: 0,
    minDecibels: -90,
    maxDecibels: -10,
    getFloatTimeDomainData: (target: Float32Array) => target.fill(level),
  };
  const monitor: CaptureMonitor = { createAnalyser: () => ({ analyser, disconnect: () => undefined }) };
  const meter: MicMeter = { monitor, release: () => undefined };
  const port: MicMeterPort = { open: async () => meter };
  const calls: SentCall[] = [];
  /** The asks to the machine to tell the ferret (`POST /v1/voice/entry`): kept apart from the utterances the person spoke. */
  const entries: { route: string; ferretId: string; session: string }[] = [];
  const refusals: { count: number; message: string } = { count: 0, message: 'The machine is not answering.' };
  const client = {
    call: async (route: string, init?: { params?: Record<string, string>; body?: unknown; headers?: unknown }) => {
      if (route === 'POST /v1/voice/entry') {
        const ask = init?.body as { ferretId: string; session: string };
        entries.push({ route, ferretId: ask.ferretId, session: ask.session });
        return { sent: true } as never;
      }
      const body = init?.body as { message: string; sendId: string };
      calls.push({
        route,
        ferretId: init?.params?.['ferretId'],
        message: body.message,
        sendId: body.sendId,
        header: (init?.headers as Record<string, string> | undefined)?.['x-fy-request-id'],
      });
      if (refusals.count > 0) {
        refusals.count -= 1;
        throw Object.assign(new Error(refusals.message), { status: 503, code: 'offline' });
      }
      return { ferret: 'ferret-1', disposition: 'delivered' } as never;
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
  return {
    provider,
    calls,
    entries,
    client,
    refusals,
    reader,
    dictation: { recognition: provider, meter: port },
    now: () => clock,
    setLevel: (next: number) => {
      level = next;
    },
    advance: (ms: number) => {
      clock += ms;
    },
    setReading: async (on: boolean) => {
      reading = on ? { ...IDLE, status: 'reading', key: 'k' } : IDLE;
      await interact(() => {
        for (const listener of [...heard]) listener();
      });
    },
  };
};

const wait = (ms: number): Promise<void> => interact(() => new Promise(resolve => setTimeout(resolve, ms)));
const until = async (condition: () => boolean, what: string): Promise<void> => {
  for (let tries = 0; tries < 60; tries += 1) {
    if (condition()) return;
    await wait(50);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const q = (selector: string): Element | null => mounted?.container.querySelector(selector) ?? null;
const text = (selector: string): string => q(selector)?.textContent ?? '';

const phoneTree = (
  p: ReturnType<typeof phone>,
  store = createVoiceModeStore(),
  patch: Partial<SttSettings> = {},
  turn: { state: 'working' | 'your-turn' | 'needs-input' | null; live: boolean } = { state: 'your-turn', live: true },
): ReactElement => (
  <ReadAloudProvider controller={p.reader}>
    <PhoneSession
      banner={keptOnPhoneBanner}
      client={p.client}
      daemon={daemon}
      dictation={p.dictation}
      ferretId="ferret-1"
      machine="desk"
      now={p.now}
      settings={settings(patch)}
      store={store}
      turn={turn}
    />
  </ReadAloudProvider>
);

/** One whole utterance: it begins, words arrive while the microphone carries speech, then a pause of quiet. */
const say = async (p: ReturnType<typeof phone>, words: string): Promise<void> => {
  const created = p.provider.created;
  await until(() => p.provider.created > created, 'the engine to be asked to listen');
  await interact(() => p.provider.begin());
  await wait(60);
  p.setLevel(0.1);
  await interact(() => p.provider.speak(words));
  await wait(260);
  p.setLevel(0);
  await wait(260);
  p.advance(PAUSE_MS + 100);
  await wait(260);
};

describe('V1: the phone engine tells the ferret too', () => {
  test('voice mode entered on the phone asks the MACHINE to tell the ferret, once, under the voice-mode session; the phone sends no entry itself', async () => {
    const p = phone();
    const store = createVoiceModeStore();
    store.start('ferret-1', 'desk', keptOnPhoneBanner);
    mounted = await mount(phoneTree(p, store));
    await until(() => p.entries.length === 1, 'the ask');
    expect(p.entries[0]).toEqual({
      route: 'POST /v1/voice/entry',
      ferretId: 'ferret-1',
      session: store.get('ferret-1').session,
    });
    // A re-render is not an entry.
    await mounted.render(phoneTree(p, store));
    await wait(100);
    expect(p.entries).toHaveLength(1);
    expect(p.calls).toEqual([]);
  });

  test('a machine lost mid-chat hands over inside the same session: the phone asks under the session the machine used', async () => {
    const r = machineRig();
    mounted = await mount(r.tree());
    await interact(() => r.store.start('ferret-1', 'desk'));
    const session = r.store.get('ferret-1').session;
    await interact(() => r.listeners().onOpen?.());
    await interact(() => r.listeners().onFrame(unit()));
    await interact(() => r.listeners().onClose('lost', 1006));
    await until(() => r.p.entries.length === 1, 'the phone to say it');
    expect(r.p.entries[0]?.session).toBe(session);
  }, 20_000);
});

describe('the panel on the phone’s own engine', () => {
  test('it says why it is on the phone, listens by itself, and sends each utterance once as (voice) words with a stable id', async () => {
    const p = phone();
    const store = createVoiceModeStore();
    store.start('ferret-1', 'desk', keptOnPhoneBanner);
    mounted = await mount(phoneTree(p, store));
    expect(q('[data-engine="phone"]')).not.toBeNull();
    expect(text('[data-voice-mode-banner]')).toBe(keptOnPhoneBanner);
    await say(p, 'fix the login redirect');
    await until(() => p.calls.length === 1, 'the utterance to be sent');
    const [call] = p.calls;
    expect(call?.route).toBe('POST /v1/ferrets/:ferretId/send');
    expect(call?.ferretId).toBe('ferret-1');
    expect(call?.message).toBe('(voice) fix the login redirect');
    expect(call?.header).toBe(call?.sendId);
    expect(call?.sendId.endsWith(':1')).toBe(true);
    await until(() => text('[data-voice-mode-outcome]') === 'Sent.', 'the Sent note');
    // The loop carries on: a second utterance is a second message under the next id of the same session.
    await say(p, 'and run the tests');
    await until(() => p.calls.length === 2, 'the second utterance');
    expect(p.calls[1]?.message).toBe('(voice) and run the tests');
    expect(p.calls[1]?.sendId).toBe(sendIdOf((p.calls[0]?.sendId ?? '').replace(/:1$/u, ''), 2));
    // Voice mode is still on, on the phone, with its banner.
    expect(store.get('ferret-1').active).toBe(true);
    expect(text('[data-voice-mode-banner]')).toBe(keptOnPhoneBanner);
  }, 20_000);

  test('a send that fails is tried again with the very same id, and one that still fails says so and keeps listening', async () => {
    const p = phone();
    p.refusals.count = 1;
    mounted = await mount(phoneTree(p));
    await say(p, 'first words');
    await until(() => p.calls.length === 2, 'the retry');
    expect(p.calls[1]?.sendId).toBe(p.calls[0]?.sendId);
    await until(() => text('[data-voice-mode-outcome]') === 'Sent.', 'the Sent note after the retry');
    p.refusals.count = 2;
    await say(p, 'second words');
    await until(() => text('[data-voice-mode-outcome]').startsWith('Not sent'), 'the Not sent note');
    expect(text('[data-voice-mode-outcome]')).toBe('Not sent: The machine is not answering.');
    expect(p.calls.length).toBe(4);
    expect(p.calls[3]?.sendId).toBe(p.calls[2]?.sendId);
    expect(q('[data-engine="phone"]')).not.toBeNull();
  }, 20_000);

  test('Mute stops the take; while a reply is read aloud nothing is heard; both give the microphone back after', async () => {
    const p = phone();
    mounted = await mount(phoneTree(p));
    await until(() => p.provider.created === 1, 'the first take');
    await interact(() => p.provider.begin());
    await interact(() => (q('[data-voice-mode-mute]') as HTMLButtonElement).click());
    expect(text('[data-voice-mode-status]')).toContain('Muted');
    expect(p.provider.recognition.aborts).toBe(1);
    await wait(400);
    expect(p.provider.created).toBe(1); // muted: no new take starts
    await interact(() => (q('[data-voice-mode-mute]') as HTMLButtonElement).click());
    await until(() => p.provider.created === 2, 'listening again after Unmute');
    await interact(() => p.provider.begin());
    await p.setReading(true);
    expect(text('[data-voice-mode-status]')).toContain('Reading the reply');
    expect(p.provider.recognition.aborts).toBe(1);
    await wait(400);
    expect(p.provider.created).toBe(2);
    await p.setReading(false);
    await until(() => p.provider.created === 3, 'listening again after the reading');
  }, 20_000);

  test('End gives the composer back, and an engine that cannot listen ends voice mode in its own sentence', async () => {
    const p = phone();
    const store = createVoiceModeStore();
    store.start('ferret-1', 'desk', keptOnPhoneBanner);
    mounted = await mount(phoneTree(p, store));
    await interact(() => (q('[data-voice-mode-end]') as HTMLButtonElement).click());
    expect(store.get('ferret-1').active).toBe(false);

    const broken = phone();
    const second = createVoiceModeStore();
    second.start('ferret-1', 'desk', keptOnPhoneBanner);
    await mounted.unmount();
    mounted = await mount(phoneTree(broken, second, { engine: null }));
    await until(() => !second.get('ferret-1').active, 'voice mode to end');
    expect(second.get('ferret-1').notice).toContain('Choose how to dictate first');
  }, 20_000);

  test('Working is told from the chat’s own reading of the ferret', async () => {
    const p = phone();
    mounted = await mount(phoneTree(p, createVoiceModeStore(), {}, { state: 'working', live: true }));
    expect(text('[data-voice-mode-status]')).toContain('Working');
    await mounted.render(phoneTree(p, createVoiceModeStore(), {}, { state: 'working', live: false }));
    expect(text('[data-voice-mode-status]')).not.toContain('Working');
  });
});

// ─── a machine that is lost mid-chat ─────────────────────────────────────────────────────────────────────────────

const NONCE = 'aaaaaaaaaaaaaaaa';
const unit = (patch: Partial<StreamSnapshot> = {}): Uint8Array =>
  encodeDownlinkUnit({ v: 1, state: 'listening', nonce: NONCE, turn: 0, ...patch });

const machineRig = () => {
  const p = phone();
  const store = createVoiceModeStore();
  let listeners!: PluginSocketListeners;
  let micStops = 0;
  const socket: PluginSocket = { send: () => undefined, close: () => undefined };
  const streamClient = {
    socket: (_route: string, _params: unknown, given: PluginSocketListeners) => {
      listeners = given;
      return socket;
    },
  };
  const mic: MicSource = {
    start: async () => undefined,
    stop: () => {
      micStops += 1;
    },
  };
  const tree = (): ReactElement => (
    <ReadAloudProvider controller={p.reader}>
      <VoiceModeSlot
        client={streamClient}
        createMic={() => mic}
        fallback={<textarea data-composer="" />}
        ferretId="ferret-1"
        renderPhone={props => (
          <PhoneSession
            {...props}
            client={p.client}
            daemon={daemon}
            dictation={p.dictation}
            now={p.now}
            settings={settings()}
          />
        )}
        store={store}
        turn={{ state: 'your-turn', live: true }}
      />
    </ReadAloudProvider>
  );
  return { p, store, tree, listeners: () => listeners, micStops: () => micStops };
};

describe('a machine lost in the middle of a voice chat', () => {
  test('the same panel carries on with the phone’s engine, says why, and the loop keeps sending', async () => {
    const r = machineRig();
    mounted = await mount(r.tree());
    await interact(() => r.store.start('ferret-1', 'desk'));
    await interact(() => r.listeners().onOpen?.());
    await interact(() => r.listeners().onFrame(unit()));
    expect(q('[data-engine="phone"]')).toBeNull();
    expect(text('[data-voice-mode-status]')).toContain('Listening');

    // The machine's route dies mid-chat (the socket drops with no close code a person pressed).
    await interact(() => r.listeners().onClose('lost', 1006));
    expect(r.store.get('ferret-1').active).toBe(true);
    expect(r.store.get('ferret-1').engine).toBe('phone');
    expect(q('[data-engine="phone"]')).not.toBeNull();
    expect(text('[data-voice-mode-banner]')).toBe(lostBanner('desk', 1006, undefined));
    expect(r.micStops()).toBeGreaterThanOrEqual(1);
    expect(q('[data-voice-mode-notice]')).toBeNull();
    expect((q('[data-voice-mode-composer]') as HTMLElement).style.display).toBe('none');

    // The loop continues on the phone.
    await say(r.p, 'are you still there');
    await until(() => r.p.calls.length === 1, 'the phone to send');
    expect(r.p.calls[0]?.message).toBe('(voice) are you still there');
  }, 20_000);

  test('the machine’s own refusal sentence is carried into the banner', async () => {
    const r = machineRig();
    mounted = await mount(r.tree());
    await interact(() => r.store.start('ferret-1', 'desk'));
    await interact(() => r.listeners().onOpen?.());
    await interact(() =>
      r.listeners().onFrame(unit({ error: { code: 'engine_failed', message: 'Speech could not start on desk.' } })),
    );
    await interact(() => r.listeners().onClose('speech failed', 1011));
    expect(text('[data-voice-mode-banner]')).toContain('Speech could not start on desk.');
    expect(text('[data-voice-mode-banner]')).toContain('phone');
  }, 20_000);

  test('a refused permission is not routed round: voice mode ends and gives the composer back', async () => {
    const r = machineRig();
    mounted = await mount(r.tree());
    await interact(() => r.store.start('ferret-1', 'desk'));
    await interact(() => r.listeners().onOpen?.());
    await interact(() => r.listeners().onClose('voice chat needs the fleet permission as well', 4403));
    expect(r.store.get('ferret-1').active).toBe(false);
    expect(q('[data-engine="phone"]')).toBeNull();
    expect(text('[data-voice-mode-notice]')).toContain('permission');
    expect((q('[data-voice-mode-composer]') as HTMLElement).style.display).toBe('contents');
  });

  test('pressing End on the machine is not a loss', async () => {
    const r = machineRig();
    mounted = await mount(r.tree());
    await interact(() => r.store.start('ferret-1', 'desk'));
    await interact(() => r.listeners().onOpen?.());
    await interact(() => (q('[data-voice-mode-end]') as HTMLButtonElement).click());
    expect(r.store.get('ferret-1').active).toBe(false);
    expect(q('[data-engine="phone"]')).toBeNull();
  });
});
