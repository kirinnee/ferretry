/**
 * LIVE IS HALF-DUPLEX, FOR EVERY SPEAKER ON THE PAGE (F137 slice 5, fix round 1) — proved through the real thing:
 * the real Composer, the real hook, runner and machine, the real Live reader over the page's ONE read-aloud
 * controller, and the real speech adapter over a fake browser `speechSynthesis`. Only the microphone, the clock and
 * the speech engine's audio are fakes.
 *
 * THE WORST FAILURE this guards: the microphone open while ANY speech plays — the ferret's own words heard, turned
 * into a message and AUTO-SENT. Every test therefore watches one invariant, at the instant each thing happens:
 * a take is never open while an audible utterance is queued in the browser, and nothing is sent that was not asked for.
 *
 * Three ways speech reaches the page while Live is on, and one each for typing and a failed hand send:
 *   1. another message takes the voice while Live reads (a Read aloud tap on an older message);
 *   2. a Read aloud tap while Live LISTENS (and while it hears you mid-sentence);
 *   3. Live starts while something is already being read;
 *   4. typing during a reading: the speech stops and the stop is the person's until Resume;
 *   5. a message sent by hand that does not go.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { IFyApiClient } from '@ferretry/protocol';
import { unitClock } from '../../../daemon/tests/support/unit-clock.ts';
import { ReadAloudControl } from '../../src/components/read-aloud.tsx';
import { Composer } from '../../src/components/composer.tsx';
import { ReadAloudProvider } from '../../src/hooks/use-read-aloud.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { DaemonDraftStore, type DraftStorage } from '../../src/lib/drafts.ts';
import { writeMdComposePref } from '../../src/lib/md-compose.ts';
import { DEFAULT_STT_SETTINGS } from '../../src/lib/stt/stt-settings.ts';
import { createLiveReader, pageVoice, QUIET_MS } from '../../src/lib/voice-chat/live-reader.ts';
import { DEFAULT_LIVE_VOICE_SETTINGS } from '../../src/lib/voice-chat/live-settings.ts';
import type { LiveRunnerPorts } from '../../src/lib/voice-chat/live-runner.ts';
import { createReadAloud } from '../../src/lib/voice-chat/read-aloud.ts';
import type { ReplySnapshot, ReplySource } from '../../src/lib/voice-chat/reply-feed.ts';
import type { PickerRow } from '../../src/lib/voice-chat/reply-picker.ts';
import { createSpeechSynthesisSpeaker } from '../../src/lib/voice-chat/speech-synthesis.ts';
import { fakeRecognitionProvider } from '../support/browser-recognition.ts';
import { interact, mount, must } from '../support/dom.ts';
import { typeInto } from '../support/dom-form.ts';
import { FakeSynth, FakeUtterance } from '../support/fake-speech.ts';
import { fakeLive } from '../support/live-ports.ts';

const daemon = daemonConnection({
  daemonId: 'daemon-a',
  baseUrl: 'https://daemon-a.example.test',
  deviceId: 'token-a',
});
const BROWSER_VOICE = { ...DEFAULT_STT_SETTINGS, engine: 'browser' } as const;

const memoryStorage = (): DraftStorage => {
  const entries = new Map<string, string>();
  return {
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
  };
};
const replySource = (): ReplySource => {
  const snapshot: ReplySnapshot = { turnState: 'your-turn', turnStateAt: 't0', status: 'running' };
  return { current: () => snapshot, subscribe: () => () => undefined };
};

const row = (id: string, kind: string, text: string): PickerRow => ({ id, kind, text });
const OLDER = 'An older message from the ferret, long ago.';
const REPLY = 'The fix is in. Run the tests next.';

const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn += 1) await interact(async () => await Promise.resolve());
};

/** The whole page over a fake browser: the speech engine's queue is what a person would HEAR. */
const rig = async () => {
  const synth = new FakeSynth();
  const speaker = createSpeechSynthesisSpeaker({ synth, createUtterance: text => new FakeUtterance(text) });
  const controller = createReadAloud({ speaker, language: () => 'en-US' });
  const fake = fakeLive();
  const world = { rows: [row('u0', 'user', 'earlier'), row('old', 'assistant', OLDER)] };
  const reader = createLiveReader({
    controller,
    source: { rows: () => world.rows, question: () => null },
    settings: () => DEFAULT_LIVE_VOICE_SETTINGS,
    clock: fake.ports.clock,
  });

  // THE INVARIANT, checked at the instant each side acts: a take (the microphone) and audible speech never overlap.
  const audible = (): boolean => synth.queue.some(utterance => utterance.volume > 0);
  // A take that stopped recording (a stop mid-sentence, waiting for its last words) no longer hears the room.
  const micOpen = (): boolean => fake.takes.some(take => !take.cancelled && !take.stopped);
  const overlaps: string[] = [];
  const watch = (what: string): void => {
    if (audible() && micOpen()) overlaps.push(what);
  };
  const speak = synth.speak.bind(synth);
  synth.speak = utterance => {
    speak(utterance);
    watch('speech began with the microphone open');
  };

  const { send: _send, reader: _reader, take, ...rest } = fake.ports;
  const ports: Partial<LiveRunnerPorts> = {
    ...rest,
    take: {
      start: listener => {
        const handle = take.start(listener);
        watch('the microphone opened under speech');
        return handle;
      },
    },
    reader,
    voice: pageVoice(controller),
  };

  const sent: { messages: string[]; fail: boolean } = { messages: [], fail: false };
  const api: Pick<IFyApiClient, 'send'> = {
    send: async (_id, input) => {
      if (sent.fail) throw new Error('daemon unreachable');
      sent.messages.push(input.message);
      return {} as never;
    },
  };
  const composer = await mount(
    <ReadAloudProvider controller={controller}>
      <Composer
        api={api}
        daemon={daemon}
        dictationRecognition={fakeRecognitionProvider({ endsOnStop: true })}
        dictationSettings={BROWSER_VOICE}
        draftStore={new DaemonDraftStore(memoryStorage())}
        sessionId="live"
        liveReply={replySource()}
        liveVoiceSeams={{ ports }}
      />
      <ReadAloudControl entryId="old" text={OLDER} />
    </ReadAloudProvider>,
  );
  const root = composer.container;
  const phase = (): string | null => root.querySelector('[data-live-phase]')?.getAttribute('data-live-phase') ?? null;
  const textarea = (): HTMLTextAreaElement => must(root.querySelector('textarea'), 'the composer textarea');
  const liveButton = (): HTMLButtonElement =>
    must(root.querySelector<HTMLButtonElement>('button[aria-label="Live voice"]'), 'the Live button');
  const readAloudButton = (): HTMLButtonElement =>
    must(root.querySelector<HTMLButtonElement>('.fy-read-aloud-button'), 'the Read aloud button');
  const sendButton = (): HTMLButtonElement =>
    must(root.querySelector<HTMLButtonElement>('button[aria-label="Send"]'), 'the Send button');
  const barButton = (label: RegExp): HTMLButtonElement =>
    must(
      [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => label.test(button.textContent ?? '')),
      `the ${label} button`,
    );
  const advance = async (ms: number): Promise<void> => {
    await interact(async () => {
      fake.advance(ms);
      await Promise.resolve();
    });
    await flush();
  };
  /** A spoken turn: speech, then enough quiet for the endpointer to end it. */
  const speakTurn = async (): Promise<void> => {
    await interact(async () => {
      fake.hear(0.1, 600);
      fake.hear(0.001, 1_520);
      await Promise.resolve();
    });
    await flush();
  };
  const startLive = async (): Promise<void> => {
    await interact(() => liveButton().click());
    await flush();
  };
  /** Live running, a turn sent, the ferret's reply on screen and being READ ALOUD. */
  const reading = async (): Promise<void> => {
    await startLive();
    await speakTurn();
    await advance(1_500);
    expect(sent.messages).toEqual(['Fix the bug.']);
    world.rows = [...world.rows, row('u1', 'user', 'Fix the bug.'), row('a1', 'assistant', REPLY)];
    await interact(async () => {
      fake.signal({ kind: 'done' });
      await Promise.resolve();
    });
    await flush();
    await advance(QUIET_MS + 200);
    expect(phase()).toBe('reading');
    expect(controller.getState()).toMatchObject({ status: 'reading', key: 'a1' });
    expect(audible()).toBe(true);
  };
  /** The loud voice of a speaker in the room, as the microphone would hear it, and the quiet that ends the turn. */
  const echo = async (): Promise<void> => {
    await interact(async () => {
      fake.outcome.current = { kind: 'words', text: 'The fix is in. Run the tests next.', raw: REPLY, cleaned: true };
      fake.hear(0.1, 600);
      fake.hear(0.001, 1_520);
      fake.advance(5_000);
      await Promise.resolve();
    });
    await flush();
  };
  return {
    synth,
    controller,
    fake,
    world,
    sent,
    composer,
    overlaps,
    audible,
    micOpen,
    phase,
    textarea,
    liveButton,
    readAloudButton,
    sendButton,
    barButton,
    advance,
    speakTurn,
    startLive,
    reading,
    echo,
  };
};

describe('Live is half-duplex against every speaker on the page', () => {
  beforeEach(() => {
    writeMdComposePref('off');
    unitClock.hold();
  });
  afterEach(() => writeMdComposePref('on'));

  it('1. another message taking the voice while Live reads: the microphone stays SHUT, nothing is heard, nothing is sent twice', async () => {
    const r = await rig();
    await r.reading();
    const takesBefore = r.fake.takes.length;

    // The person taps Read aloud on an OLDER message while Live is reading the reply: the voice moves there.
    await interact(() => r.readAloudButton().click());
    await flush();
    expect(r.controller.getState()).toMatchObject({ status: 'reading', key: 'old' });
    expect(r.audible()).toBe(true);
    // Live gave the voice up; it did NOT stop the thief, and it did NOT open the microphone under it.
    expect(r.phase()).toBe('hold');
    expect(r.composer.container.textContent).toContain('Another message is being read aloud');
    expect(r.fake.takes.length).toBe(takesBefore);
    expect(r.micOpen()).toBe(false);

    // The older message is read to the end: Live stays On hold — it does not reopen by itself behind the speaker.
    await interact(async () => {
      r.synth.play(1);
      await Promise.resolve();
    });
    await flush();
    expect(r.controller.getState().status).toBe('finished');
    expect(r.phase()).toBe('hold');
    expect(r.micOpen()).toBe(false);

    // The synthetic echo (the ferret's own words, loud, with quiet after) finds no open microphone: no second send.
    await r.echo();
    expect(r.sent.messages).toEqual(['Fix the bug.']);

    // Listen is the person's decision to talk: only then does the microphone open, and a turn then sends.
    await interact(() => r.barButton(/^Listen/).click());
    await flush();
    expect(r.phase()).toBe('listening');
    expect(r.micOpen()).toBe(true);
    expect(r.overlaps).toEqual([]);
    await r.composer.unmount();
  });

  it('1b. Listen while the other message is STILL being read cuts it first, so the microphone never opens under it', async () => {
    const r = await rig();
    await r.reading();
    await interact(() => r.readAloudButton().click());
    await flush();
    expect(r.phase()).toBe('hold');
    expect(r.audible()).toBe(true);
    await interact(() => r.barButton(/^Listen/).click());
    await flush();
    // The voice was silenced before the microphone opened; the person asked to talk.
    expect(r.audible()).toBe(false);
    expect(r.controller.getState().status).toBe('stopped');
    expect(r.phase()).toBe('listening');
    expect(r.micOpen()).toBe(true);
    expect(r.overlaps).toEqual([]);
    await r.composer.unmount();
  });

  it('2. a Read aloud tap while Live LISTENS closes the microphone first: the speech is never heard, never sent', async () => {
    const r = await rig();
    await r.startLive();
    expect(r.phase()).toBe('listening');
    expect(r.micOpen()).toBe(true);

    await interact(() => r.readAloudButton().click());
    await flush();
    expect(r.audible()).toBe(true);
    expect(r.micOpen()).toBe(false);
    expect(r.phase()).toBe('hold');
    expect(r.fake.takes.every(take => take.cancelled)).toBe(true);

    // The speaker is heard by nobody: even a loud room and a quiet end send nothing, then and after it finishes.
    await r.echo();
    await interact(async () => {
      r.synth.play(1);
      await Promise.resolve();
    });
    await flush();
    await r.echo();
    expect(r.sent.messages).toEqual([]);
    expect(r.phase()).toBe('hold');
    expect(r.overlaps).toEqual([]);
    await r.composer.unmount();
  });

  it('2b. a Read aloud tap while Live HEARS you mid-sentence: what was said is kept in the box, never sent', async () => {
    const r = await rig();
    await r.startLive();
    await interact(async () => {
      r.fake.hear(0.1, 600);
      await Promise.resolve();
    });
    await flush();
    expect(r.phase()).toBe('hearing');
    await interact(() => r.readAloudButton().click());
    await flush();
    expect(r.micOpen()).toBe(false);
    await r.advance(10_000);
    expect(r.phase()).toBe('hold');
    expect(r.textarea().value).toBe('Fix the bug.');
    expect(r.sent.messages).toEqual([]);
    expect(r.overlaps).toEqual([]);
    await r.composer.unmount();
  });

  it('3. starting Live while something is being read cuts the speech first: the microphone never opens under it', async () => {
    const r = await rig();
    await interact(() => r.readAloudButton().click());
    await flush();
    expect(r.audible()).toBe(true);
    await r.startLive();
    expect(r.audible()).toBe(false);
    expect(r.phase()).toBe('listening');
    expect(r.micOpen()).toBe(true);
    expect(r.overlaps).toEqual([]);
    await r.composer.unmount();
  });

  it('typing during a reading stops the speech AT ONCE and holds: the unsent draft is never sent by a later spoken turn', async () => {
    const r = await rig();
    await r.reading();
    await typeInto(r.textarea(), 'PRIVATE UNSENT DRAFT', 'textarea');
    await flush();
    // The speech stopped the moment the person typed, and the stop is theirs: On hold, microphone shut.
    expect(r.audible()).toBe(false);
    expect(r.phase()).toBe('hold');
    expect(r.composer.container.textContent).toContain('Paused while you type');
    expect(r.micOpen()).toBe(false);

    // A loud turn afterwards — and time — find no open microphone: the draft is not sent, and still there.
    await r.echo();
    await r.advance(20_000);
    expect(r.sent.messages).toEqual(['Fix the bug.']);
    expect(r.textarea().value).toBe('PRIVATE UNSENT DRAFT');
    expect(r.phase()).toBe('hold');
    expect(r.micOpen()).toBe(false);

    // Resume is explicit: it listens again, and the draft the person typed still never rides along with a voice send.
    await interact(() => r.barButton(/^Resume/).click());
    await flush();
    expect(r.phase()).toBe('listening');
    await r.speakTurn();
    await r.advance(10_000);
    expect(r.sent.messages).toEqual(['Fix the bug.']);
    expect(r.textarea().value).toContain('PRIVATE UNSENT DRAFT');
    expect(r.overlaps).toEqual([]);
    await r.composer.unmount();
  });

  it('a message sent by hand that does not go leaves Live On hold with the draft kept: it never waits on a turn that never began', async () => {
    const r = await rig();
    await r.reading();
    await typeInto(r.textarea(), 'one more thing', 'textarea');
    await flush();
    r.sent.fail = true;
    await interact(() => r.sendButton().click());
    await flush();
    expect(r.sent.messages).toEqual(['Fix the bug.']);
    expect(r.textarea().value).toBe('one more thing');
    expect(r.phase()).toBe('hold');
    expect(r.composer.container.querySelector('[data-live-phase="working"]')).toBeNull();
    expect(r.audible()).toBe(false);
    expect(r.micOpen()).toBe(false);
    await r.composer.unmount();
  });

  it('a message sent by hand that goes stops the reading, and Live stays On hold until Resume', async () => {
    const r = await rig();
    await r.reading();
    await typeInto(r.textarea(), 'one more thing', 'textarea');
    await flush();
    await interact(() => r.sendButton().click());
    await flush();
    expect(r.sent.messages).toEqual(['Fix the bug.', 'one more thing']);
    expect(r.audible()).toBe(false);
    expect(r.phase()).toBe('hold');
    expect(r.micOpen()).toBe(false);
    expect(r.overlaps).toEqual([]);
    await r.composer.unmount();
  });
});
