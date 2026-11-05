/**
 * Live voice through the REAL composer: the words of a turn appear in the box, the composer's own send
 * sends exactly what is shown after the countdown, typing pauses auto-send, a failed send is On hold with
 * the words kept, and a device that may not send gets no Live button. The speech engine, the clock and the
 * microphone are fakes (`support/live-ports.ts`); the machine, the runner, the hook, the control, the bar and
 * the composer are the real ones.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { IFyApiClient } from '@ferretry/protocol';
import { unitClock } from '../../../daemon/tests/support/unit-clock.ts';
import { Composer } from '../../src/components/composer.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { DaemonDraftStore, type DraftStorage } from '../../src/lib/drafts.ts';
import { writeMdComposePref } from '../../src/lib/md-compose.ts';
import { DEFAULT_STT_SETTINGS } from '../../src/lib/stt/stt-settings.ts';
import { LIVE_VOICE_TOGGLE_EVENT } from '../../src/lib/voice-chat/live-command.ts';
import type { ReplySnapshot, ReplySource } from '../../src/lib/voice-chat/reply-feed.ts';
import { interact, mount, must } from '../support/dom.ts';
import { typeInto } from '../support/dom-form.ts';
import { fakeRecognitionProvider } from '../support/browser-recognition.ts';
import { type FakeLive, fakeLive } from '../support/live-ports.ts';

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

const textareaOf = (container: HTMLElement): HTMLTextAreaElement =>
  must(container.querySelector('textarea'), 'the composer textarea');
const liveButton = (container: HTMLElement): HTMLButtonElement | null =>
  container.querySelector<HTMLButtonElement>('button[aria-label="Live voice"]');
const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn += 1) await interact(async () => await Promise.resolve());
};

interface Sent {
  readonly messages: string[];
  fail: boolean;
}

const rig = async (
  options: { live?: boolean; disabled?: boolean; compact?: boolean; reader?: boolean; onLiveActive?: boolean[] } = {},
) => {
  const fake = fakeLive({ reader: options.reader === true });
  // Everything but the send is a fake: the words go through the composer's own send.
  const { send: _send, ...ports } = fake.ports;
  const sent: Sent = { messages: [], fail: false };
  const api: Pick<IFyApiClient, 'send'> = {
    send: async (_id, input) => {
      if (sent.fail) throw new Error('daemon unreachable');
      sent.messages.push(input.message);
      return {} as never;
    },
  };
  const composer = await mount(
    <Composer
      api={api}
      daemon={daemon}
      dictationRecognition={fakeRecognitionProvider({ endsOnStop: true })}
      dictationSettings={BROWSER_VOICE}
      draftStore={new DaemonDraftStore(memoryStorage())}
      sessionId="live"
      {...(options.live === false ? {} : { liveReply: replySource() })}
      {...(options.disabled === true ? { disabled: true } : {})}
      {...(options.compact === true ? { compact: true } : {})}
      {...(options.onLiveActive === undefined
        ? {}
        : { onLiveActiveChange: (on: boolean) => options.onLiveActive?.push(on) })}
      liveVoiceSeams={{ ports }}
    />,
  );
  return { composer, fake, sent };
};

/** One spoken turn: speech, then enough quiet for the endpointer to end it. */
const speakTurn = async (fake: FakeLive): Promise<void> => {
  await interact(async () => {
    fake.hear(0.1, 600);
    fake.hear(0.001, 1_520);
    await Promise.resolve();
  });
  await flush();
};

describe('Composer Live voice', () => {
  // Hooks inside the describe: a top-level one would also run for every other file in the same process.
  beforeEach(() => {
    writeMdComposePref('off');
    unitClock.hold();
  });
  afterEach(() => writeMdComposePref('on'));

  it('offers no Live button without a session to watch, or to a composer that may not send', async () => {
    const noReply = await rig({ live: false });
    expect(liveButton(noReply.composer.container)).toBeNull();
    await noReply.composer.unmount();
    const disabled = await rig({ disabled: true });
    expect(liveButton(disabled.composer.container)).toBeNull();
    await disabled.composer.unmount();
  });

  it('shows the words, counts down, sends exactly what is shown, and waits for the ferret', async () => {
    const { composer, fake, sent } = await rig();
    const textarea = textareaOf(composer.container);
    await interact(() => must(liveButton(composer.container), 'the Live button').click());
    await flush();
    expect(composer.container.querySelector('[aria-label="Live voice"][data-live-phase]')).not.toBeNull();

    await speakTurn(fake);
    // The words of the turn are in the box, where the person can see and edit them.
    expect(textarea.value).toBe('Fix the bug.');
    expect(sent.messages).toEqual([]);

    await interact(async () => {
      fake.advance(1_500);
      await Promise.resolve();
    });
    await flush();
    expect(sent.messages).toEqual(['Fix the bug.']);
    expect(textarea.value).toBe('');
    expect(composer.container.textContent).toContain('Working');
    await composer.unmount();
  });

  it('keeps what was typed before Live in front of the words', async () => {
    const { composer, fake, sent } = await rig();
    const textarea = textareaOf(composer.container);
    await typeInto(textarea, 'Please', 'textarea');
    await interact(() => must(liveButton(composer.container), 'the Live button').click());
    await flush();
    await speakTurn(fake);
    expect(textarea.value).toBe('Please Fix the bug.');
    await interact(async () => {
      fake.advance(1_500);
      await Promise.resolve();
    });
    await flush();
    expect(sent.messages).toEqual(['Please Fix the bug.']);
    await composer.unmount();
  });

  it('takes the preview words out again when the turn came to nothing, leaving what was typed', async () => {
    const { composer, fake, sent } = await rig();
    const textarea = textareaOf(composer.container);
    await typeInto(textarea, 'Please', 'textarea');
    await interact(() => must(liveButton(composer.container), 'the Live button').click());
    await flush();
    fake.outcome.current = { kind: 'empty' };
    await interact(() => fake.listeners[0]?.onLive('hmm'));
    await speakTurn(fake);
    expect(textarea.value).toBe('Please');
    expect(composer.container.textContent).toContain('Listening');
    expect(sent.messages).toEqual([]);
    await composer.unmount();
  });

  it('pauses when the person types, and sends only on their word', async () => {
    const { composer, fake, sent } = await rig();
    const textarea = textareaOf(composer.container);
    await interact(() => must(liveButton(composer.container), 'the Live button').click());
    await flush();
    await speakTurn(fake);
    await typeInto(textarea, 'Fix the bug. And the tests.', 'textarea');
    await flush();
    expect(composer.container.textContent).toContain('On hold');
    await interact(async () => {
      fake.advance(5_000);
      await Promise.resolve();
    });
    expect(sent.messages).toEqual([]);
    const sendNow = must(
      [...composer.container.querySelectorAll<HTMLButtonElement>('button')].find(button =>
        /send now/i.test(button.textContent ?? ''),
      ),
      'the Send now button',
    );
    await interact(() => sendNow.click());
    await flush();
    expect(sent.messages).toEqual(['Fix the bug. And the tests.']);
    await composer.unmount();
  });

  it('puts the words on hold, kept in the box, when the send fails', async () => {
    const { composer, fake, sent } = await rig();
    sent.fail = true;
    const textarea = textareaOf(composer.container);
    await interact(() => must(liveButton(composer.container), 'the Live button').click());
    await flush();
    await speakTurn(fake);
    await interact(async () => {
      fake.advance(1_500);
      await Promise.resolve();
    });
    await flush();
    expect(composer.container.textContent).toContain('On hold');
    expect(textarea.value).toBe('Fix the bug.');
    await composer.unmount();
  });

  it('toggles from the request of the command palette, and not while the mic is recording', async () => {
    const { composer, fake } = await rig();
    await interact(() => void document.dispatchEvent(new Event(LIVE_VOICE_TOGGLE_EVENT)));
    await flush();
    expect(liveButton(composer.container)?.getAttribute('aria-pressed')).toBe('true');
    await interact(() => void document.dispatchEvent(new Event(LIVE_VOICE_TOGGLE_EVENT)));
    await flush();
    expect(liveButton(composer.container)?.getAttribute('aria-pressed')).toBe('false');
    expect(fake.takes.length).toBe(1);
    // With the mic recording, Live waits: the button is held back and the request does nothing.
    const mic = must(
      composer.container.querySelector<HTMLButtonElement>('button[aria-label="Dictate a message"]'),
      'the mic button',
    );
    await interact(() => mic.click());
    await flush();
    expect(liveButton(composer.container)?.disabled).toBe(true);
    await interact(() => void document.dispatchEvent(new Event(LIVE_VOICE_TOGGLE_EVENT)));
    await flush();
    expect(fake.takes.length).toBe(1);
    await composer.unmount();
  });

  it('puts the Live button in the phone dock beside the mic, and runs from there', async () => {
    const { composer, fake, sent } = await rig({ compact: true });
    const dock = must(composer.container.querySelector('[data-composer-dock="start"]'), 'the start dock');
    const button = must(liveButton(composer.container), 'the Live button');
    expect(dock.contains(button)).toBe(true);
    await interact(() => button.click());
    await flush();
    await speakTurn(fake);
    await interact(async () => {
      fake.advance(1_500);
      await Promise.resolve();
    });
    await flush();
    expect(sent.messages).toEqual(['Fix the bug.']);
    await composer.unmount();
  });

  it('holds the mic back while Live is on, and ends from the button', async () => {
    const { composer, fake } = await rig();
    const button = must(liveButton(composer.container), 'the Live button');
    await interact(() => button.click());
    await flush();
    expect(button.getAttribute('aria-pressed')).toBe('true');
    const mic = composer.container.querySelector<HTMLButtonElement>('button[aria-label="Dictate a message"]');
    expect(mic?.disabled).toBe(true);
    await interact(() => button.click());
    await flush();
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(fake.takes[0]?.cancelled).toBe(true);
    unitClock.advance(0);
    await composer.unmount();
  });
});

describe('Composer Live voice — reading the reply (slice 5)', () => {
  beforeEach(() => {
    writeMdComposePref('off');
    unitClock.hold();
  });
  afterEach(() => writeMdComposePref('on'));

  /** Start Live, speak a turn, let it send, and leave it working. */
  const working = async (options: Parameters<typeof rig>[0] = {}) => {
    const r = await rig({ reader: true, ...options });
    await interact(() => must(liveButton(r.composer.container), 'the Live button').click());
    await flush();
    await speakTurn(r.fake);
    await interact(async () => {
      r.fake.advance(1_500);
      await Promise.resolve();
    });
    await flush();
    expect(r.sent.messages).toEqual(['Fix the bug.']);
    return r;
  };
  const done = async (fake: FakeLive): Promise<void> => {
    await interact(async () => {
      fake.signal({ kind: 'done' });
      await Promise.resolve();
    });
    await flush();
  };

  it('tells the page when Live is on and off, so its own auto-read can stand down', async () => {
    const seen: boolean[] = [];
    const { composer } = await rig({ reader: true, onLiveActive: seen });
    await interact(() => must(liveButton(composer.container), 'the Live button').click());
    await flush();
    expect(seen.at(-1)).toBe(true);
    // The Live button toggles: pressing it again ends Live.
    await interact(() => must(liveButton(composer.container), 'the Live button').click());
    await flush();
    expect(seen.at(-1)).toBe(false);
    await composer.unmount();
  });

  it('reads the reply: the bar says Reading reply with Stop, Repeat and End — and the live region never says the reply', async () => {
    const { composer, fake } = await working();
    expect(fake.reader.marks.count).toBe(1);
    await done(fake);
    expect(fake.reader.reads).toEqual(['reply']);
    const bar = composer.container.querySelector('[data-live-phase="reading"]');
    expect(bar).not.toBeNull();
    const labels = [...(bar?.querySelectorAll('button') ?? [])].map(button => button.textContent?.trim());
    expect(labels.some(label => label?.startsWith('Stop reading'))).toBe(true);
    expect(labels.some(label => label?.startsWith('Repeat'))).toBe(true);
    expect(labels).toContain('End');
    expect(bar?.querySelector('[data-live-region]')?.textContent).toBe('Reading reply');
    // Done speaking: Live listens again.
    await interact(async () => {
      fake.reader.end('finished');
      await Promise.resolve();
    });
    await flush();
    expect(composer.container.querySelector('[data-live-phase="listening"]')).not.toBeNull();
    await composer.unmount();
  });

  it('Space and Esc stop the reading and listen again; S too; R reads it again', async () => {
    const { composer, fake } = await working();
    await done(fake);
    await interact(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true })));
    await flush();
    expect(fake.reader.reads).toEqual(['reply', 'reply']);
    await interact(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await flush();
    expect(fake.reader.stops.count).toBeGreaterThan(0);
    // Esc stopped the READING; Live is still on and listening.
    expect(composer.container.querySelector('[data-live-phase="listening"]')).not.toBeNull();
    await composer.unmount();
  });

  it('a question is read and Live stops at the prompt: the words said cannot approve anything', async () => {
    const { composer, fake, sent } = await working();
    await interact(async () => {
      fake.signal({ kind: 'needs-input' });
      await Promise.resolve();
    });
    await flush();
    expect(fake.reader.reads).toEqual(['question']);
    await interact(async () => {
      fake.reader.end('finished');
      await Promise.resolve();
    });
    await flush();
    expect(composer.container.querySelector('[data-live-phase="hold"]')).not.toBeNull();
    await interact(async () => {
      fake.hear(0.1, 600);
      fake.hear(0.001, 1_520);
      fake.advance(5_000);
      await Promise.resolve();
    });
    await flush();
    expect(sent.messages).toEqual(['Fix the bug.']);
    await composer.unmount();
  });

  it('a message sent by hand while a reply is read stops the reading', async () => {
    const { composer, fake, sent } = await working();
    await done(fake);
    expect(composer.container.querySelector('[data-live-phase="reading"]')).not.toBeNull();
    const textarea = textareaOf(composer.container);
    await typeInto(textarea, 'one more thing', 'textarea');
    await interact(() =>
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })),
    );
    await flush();
    expect(sent.messages).toEqual(['Fix the bug.', 'one more thing']);
    expect(fake.reader.stops.count).toBeGreaterThan(0);
    expect(composer.container.querySelector('[data-live-phase="reading"]')).toBeNull();
    await composer.unmount();
  });
});
