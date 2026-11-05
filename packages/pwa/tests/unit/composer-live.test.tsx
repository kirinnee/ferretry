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
import type { MicLockPort } from '../../src/lib/voice-chat/ports.ts';
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

const rig = async (options: { live?: boolean; disabled?: boolean; compact?: boolean; micLock?: MicLockPort } = {}) => {
  const fake = fakeLive();
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
      liveVoiceSeams={{ ports: options.micLock === undefined ? ports : { ...ports, micLock: options.micLock } }}
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

  it('keeps what was typed before Live in front of the words, and NEVER sends it by itself: it waits On hold for the person', async () => {
    const { composer, fake, sent } = await rig();
    const textarea = textareaOf(composer.container);
    await typeInto(textarea, 'Please', 'textarea');
    await interact(() => must(liveButton(composer.container), 'the Live button').click());
    await flush();
    await speakTurn(fake);
    expect(textarea.value).toBe('Please Fix the bug.');
    expect(composer.container.querySelector('[data-live-phase=hold]')).not.toBeNull();
    await interact(async () => {
      fake.advance(10_000);
      await Promise.resolve();
    });
    await flush();
    expect(sent.messages).toEqual([]);
    const sendNow = must(
      [...composer.container.querySelectorAll<HTMLButtonElement>('button')].find(button =>
        /send now/i.test(button.textContent ?? ''),
      ),
      'the Send now button',
    );
    await interact(() => sendNow.click());
    await flush();
    expect(sent.messages).toEqual(['Please Fix the bug.']);
    await composer.unmount();
  });

  it('takes the preview words out again when the turn came to nothing, leaving the box empty and Live listening', async () => {
    const { composer, fake, sent } = await rig();
    const textarea = textareaOf(composer.container);
    await interact(() => must(liveButton(composer.container), 'the Live button').click());
    await flush();
    fake.outcome.current = { kind: 'empty' };
    await interact(() => fake.listeners[0]?.onLive('hmm'));
    await speakTurn(fake);
    expect(textarea.value).toBe('');
    expect(composer.container.textContent).toContain('Listening');
    expect(sent.messages).toEqual([]);
    await composer.unmount();
  });

  it('takes the preview words out again, leaving what was typed, and holds for it (a turn of nothing with typed text)', async () => {
    const { composer, fake, sent } = await rig();
    const textarea = textareaOf(composer.container);
    await typeInto(textarea, 'Please', 'textarea');
    await interact(() => must(liveButton(composer.container), 'the Live button').click());
    await flush();
    fake.outcome.current = { kind: 'empty' };
    await interact(() => fake.listeners[0]?.onLive('hmm'));
    await speakTurn(fake);
    expect(textarea.value).toBe('Please');
    expect(composer.container.querySelector('[data-live-phase=hold]')).not.toBeNull();
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

  /** Press the bar's Resume. */
  const resume = async (container: HTMLElement): Promise<void> => {
    const button = must(
      [...container.querySelectorAll<HTMLButtonElement>('button')].find(candidate =>
        /resume/i.test(candidate.textContent ?? ''),
      ),
      'the Resume button',
    );
    await interact(() => button.click());
    await flush();
  };

  it('after the ferret answers a normal turn Live listens again: the box the send emptied is not typing', async () => {
    const { composer, fake, sent } = await rig();
    await interact(() => must(liveButton(composer.container), 'the Live button').click());
    await flush();
    await speakTurn(fake);
    await interact(async () => {
      fake.advance(1_500);
      await Promise.resolve();
    });
    await flush();
    expect(sent.messages).toEqual(['Fix the bug.']);
    expect(composer.container.querySelector('[data-live-phase=working]')).not.toBeNull();
    await interact(() => fake.signal({ kind: 'done' }));
    await flush();
    expect(composer.container.querySelector('[data-live-phase=listening]')).not.toBeNull();
    await composer.unmount();
  });

  it('THE SURPRISE-SEND RULE: typing while the ferret works holds Live when it answers, and the unfinished draft never rides along with a voice send', async () => {
    const { composer, fake, sent } = await rig();
    const textarea = textareaOf(composer.container);
    await interact(() => must(liveButton(composer.container), 'the Live button').click());
    await flush();
    await speakTurn(fake);
    await interact(async () => {
      fake.advance(1_500);
      await Promise.resolve();
    });
    await flush();
    expect(sent.messages).toEqual(['Fix the bug.']);

    await typeInto(textarea, 'UNFINISHED typed instruction', 'textarea');
    await flush();
    // The reply watch carries on: Live is still working, nothing was cancelled.
    expect(composer.container.querySelector('[data-live-phase=working]')).not.toBeNull();
    await interact(() => fake.signal({ kind: 'done' }));
    await flush();

    // The reply landed: Live is ON HOLD, the microphone is not reopened, the draft is untouched.
    expect(composer.container.querySelector('[data-live-phase=hold]')).not.toBeNull();
    expect(composer.container.querySelector('[data-live-phase=listening]')).toBeNull();
    expect(fake.takes.length).toBe(1);
    expect(textarea.value).toBe('UNFINISHED typed instruction');

    // Room speech and every clock tick afterwards send nothing.
    fake.outcome.current = { kind: 'words', text: 'background speech', raw: 'background speech', cleaned: false };
    await speakTurn(fake);
    await interact(async () => {
      fake.advance(60_000);
      await Promise.resolve();
    });
    await flush();
    expect(sent.messages).toEqual(['Fix the bug.']);
    expect(textarea.value).toBe('UNFINISHED typed instruction');

    // Resume is the person's word: the microphone reopens, but a draft in the box still means no auto-send.
    await resume(composer.container);
    expect(composer.container.querySelector('[data-live-phase=listening]')).not.toBeNull();
    await speakTurn(fake);
    await interact(async () => {
      fake.advance(60_000);
      await Promise.resolve();
    });
    await flush();
    expect(sent.messages).toEqual(['Fix the bug.']);
    expect(composer.container.querySelector('[data-live-phase=hold]')).not.toBeNull();
    expect(textarea.value).toBe('UNFINISHED typed instruction background speech');
    await composer.unmount();
  });

  it('THE SURPRISE-SEND RULE: typing while Live is still starting (the lock is pending) holds it; nothing listens or sends when the lock arrives', async () => {
    let grant: (granted: boolean) => void = () => undefined;
    const micLock: MicLockPort = {
      acquire: () =>
        new Promise<boolean>(resolve => {
          grant = resolve;
        }),
      release: () => undefined,
    };
    const { composer, fake, sent } = await rig({ micLock });
    const textarea = textareaOf(composer.container);
    await interact(() => must(liveButton(composer.container), 'the Live button').click());
    await flush();
    expect(composer.container.querySelector('[data-live-phase=starting]')).not.toBeNull();

    await typeInto(textarea, 'half a thought', 'textarea');
    await flush();
    expect(composer.container.querySelector('[data-live-phase=hold]')).not.toBeNull();

    await interact(async () => {
      grant(true);
      await Promise.resolve();
    });
    await flush();
    await speakTurn(fake);
    await interact(async () => {
      fake.advance(60_000);
      await Promise.resolve();
    });
    await flush();
    expect(sent.messages).toEqual([]);
    expect(textarea.value).toBe('half a thought');
    expect(composer.container.querySelector('[data-live-phase=hold]')).not.toBeNull();
    await composer.unmount();
  });

  it('Hold in the middle of a sentence keeps the words: they appear in the box and nothing is sent', async () => {
    const { composer, fake, sent } = await rig();
    const textarea = textareaOf(composer.container);
    await interact(() => must(liveButton(composer.container), 'the Live button').click());
    await flush();
    await interact(async () => {
      fake.hear(0.1, 600);
      await Promise.resolve();
    });
    await flush();
    expect(composer.container.querySelector('[data-live-phase=hearing]')).not.toBeNull();
    const hold = must(
      [...composer.container.querySelectorAll<HTMLButtonElement>('button')].find(button =>
        /^hold/i.test((button.textContent ?? '').trim()),
      ),
      'the Hold button',
    );
    await interact(() => hold.click());
    await flush();
    expect(textarea.value).toBe('Fix the bug.');
    expect(composer.container.querySelector('[data-live-phase=hold]')).not.toBeNull();
    expect(fake.takes[0]?.stopped).toBe(true);
    await interact(async () => {
      fake.advance(60_000);
      await Promise.resolve();
    });
    expect(sent.messages).toEqual([]);
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

const pressAction = async (container: HTMLElement, action: string): Promise<void> => {
  const button = must(
    [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      b => b.getAttribute('data-live-action') === action,
    ),
    `the ${action} button`,
  );
  await interact(() => button.click());
  await flush();
};

/** A keystroke, the way the browser makes one: the value changes and `input` fires, with no act in between. */
const typeNow = (textarea: HTMLTextAreaElement, value: string): void => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
};

const phaseOf = (container: HTMLElement): string | null =>
  container.querySelector('[data-live-phase]')?.getAttribute('data-live-phase') ?? null;

describe('Composer Live voice — THE SURPRISE-SEND RULE through the real composer', () => {
  beforeEach(() => {
    writeMdComposePref('off');
    unitClock.hold();
  });
  afterEach(() => writeMdComposePref('on'));

  const start = async () => {
    const world = await rig();
    await interact(() => must(liveButton(world.composer.container), 'the Live button').click());
    await flush();
    return world;
  };

  it("the composer's own Send during a slow decode sends the preview ONCE; the pending take cannot re-insert and send it again, and the mic stays shut", async () => {
    const { composer, fake, sent } = await start();
    fake.decodeMs.current = 2_000;
    await interact(() => fake.listeners[0]?.onLive('Fix the bug.'));
    await speakTurn(fake);
    expect(textareaOf(composer.container).value).toBe('Fix the bug.');
    const send = must(composer.container.querySelector<HTMLButtonElement>('button[type=submit]'), 'the Send button');
    await interact(() => send.click());
    await flush();
    expect(sent.messages).toEqual(['Fix the bug.']);
    // The first real turn: Live is working, the microphone is off, the take is gone.
    expect(phaseOf(composer.container)).toBe('working');
    expect(fake.takes[0]?.cancelled).toBe(true);
    // The slow decode answers and the countdown would have run out: nothing comes back, nothing goes twice.
    await interact(() => fake.advance(2_500));
    await flush();
    await interact(() => fake.advance(5_000));
    await flush();
    expect(sent.messages).toEqual(['Fix the bug.']);
    expect(textareaOf(composer.container).value).toBe('');
    expect(phaseOf(composer.container)).toBe('working');
    expect(fake.takes.length).toBe(1);
    await composer.unmount();
  });

  it('Enter in the box is the same press, and a typed message is retired the same way', async () => {
    const { composer, fake, sent } = await start();
    const textarea = textareaOf(composer.container);
    await interact(async () => typeNow(textarea, 'typed by hand'));
    await flush();
    expect(phaseOf(composer.container)).toBe('hold');
    await interact(() => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    await flush();
    expect(sent.messages).toEqual(['typed by hand']);
    expect(phaseOf(composer.container)).toBe('working');
    await interact(() => fake.advance(60_000));
    expect(sent.messages).toEqual(['typed by hand']);
    await composer.unmount();
  });

  it('a press that fails is On hold with the words kept, and Live does not send them itself', async () => {
    const { composer, fake, sent } = await start();
    sent.fail = true;
    await speakTurn(fake);
    const send = must(composer.container.querySelector<HTMLButtonElement>('button[type=submit]'), 'the Send button');
    await interact(() => send.click());
    await flush();
    expect(phaseOf(composer.container)).toBe('hold');
    expect(textareaOf(composer.container).value).toBe('Fix the bug.');
    await interact(() => fake.advance(60_000));
    expect(sent.messages).toEqual([]);
    await composer.unmount();
  });

  it('typing the instant the countdown ends — before React commits the send — sends NOTHING, and the typed words stay', async () => {
    const { composer, fake, sent } = await start();
    const textarea = textareaOf(composer.container);
    await speakTurn(fake);
    await interact(async () => {
      fake.advance(1_500);
      typeNow(textarea, 'UNFINISHED REPLACEMENT');
    });
    await flush();
    expect(sent.messages).toEqual([]);
    expect(textarea.value).toBe('UNFINISHED REPLACEMENT');
    expect(phaseOf(composer.container)).toBe('hold');
    await interact(() => fake.advance(60_000));
    await flush();
    expect(sent.messages).toEqual([]);
    await composer.unmount();
  });

  it('End before React commits the send sends nothing', async () => {
    const { composer, fake, sent } = await start();
    await speakTurn(fake);
    await interact(async () => {
      fake.advance(1_500);
      must(liveButton(composer.container), 'the Live button').click();
    });
    await flush();
    expect(sent.messages).toEqual([]);
    expect(liveButton(composer.container)?.getAttribute('aria-pressed')).toBe('false');
    expect(textareaOf(composer.container).value).toBe('Fix the bug.');
    await composer.unmount();
  });

  it('Hold, and a hidden tab, before React commits the send send nothing and keep the words', async () => {
    for (const stop of ['hold', 'hidden'] as const) {
      const { composer, fake, sent } = await start();
      await speakTurn(fake);
      await interact(async () => {
        fake.advance(1_500);
        if (stop === 'hold') {
          const hold = must(
            [...composer.container.querySelectorAll<HTMLButtonElement>('button')].find(
              b => b.getAttribute('data-live-action') === 'Hold',
            ),
            'the Hold button',
          );
          hold.click();
        } else fake.setVisible(false);
      });
      await flush();
      expect(sent.messages).toEqual([]);
      expect(phaseOf(composer.container)).toBe(stop === 'hold' ? 'hold' : 'paused');
      expect(textareaOf(composer.container).value).toBe('Fix the bug.');
      await composer.unmount();
    }
  });

  it('the page leaving before React commits the send sends nothing', async () => {
    const { composer, fake, sent } = await start();
    await speakTurn(fake);
    await interact(async () => {
      fake.advance(1_500);
      await composer.unmount();
    });
    await flush();
    expect(sent.messages).toEqual([]);
  });

  it('a box edited by anything but a keystroke (the words changed under the approval) is not sent either', async () => {
    const { composer, fake, sent } = await start();
    await speakTurn(fake);
    // The approved send is queued; the box changes without an input event Live can hear first.
    await interact(async () => {
      fake.advance(1_500);
      const textarea = textareaOf(composer.container);
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
        textarea,
        'Fix the bug. Also deploy.',
      );
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    expect(sent.messages).not.toContain('Fix the bug. Also deploy.');
    await composer.unmount();
  });
});

describe('Composer Live voice — a new take never replaces a finished one', () => {
  beforeEach(() => {
    writeMdComposePref('off');
    unitClock.hold();
  });
  afterEach(() => writeMdComposePref('on'));

  const second = (fake: FakeLive): void => {
    fake.outcome.current = { kind: 'words', text: 'And run tests.', raw: 'and run tests', cleaned: true };
  };

  it('Hold, Resume, speak again: the held sentence stays and the new one follows it; the countdown then sends both, once', async () => {
    const { composer, fake, sent } = await rig();
    const textarea = textareaOf(composer.container);
    await interact(() => must(liveButton(composer.container), 'the Live button').click());
    await flush();
    await speakTurn(fake);
    await pressAction(composer.container, 'Hold');
    expect(textarea.value).toBe('Fix the bug.');
    await pressAction(composer.container, 'Resume');
    second(fake);
    await speakTurn(fake);
    expect(textarea.value).toBe('Fix the bug. And run tests.');
    expect(sent.messages).toEqual([]);
    await interact(async () => {
      fake.advance(1_500);
      await Promise.resolve();
    });
    await flush();
    expect(sent.messages).toEqual(['Fix the bug. And run tests.']);
    await composer.unmount();
  });

  it('a hidden tab, then back: the same — the first sentence is not written over', async () => {
    const { composer, fake } = await rig();
    const textarea = textareaOf(composer.container);
    await interact(() => must(liveButton(composer.container), 'the Live button').click());
    await flush();
    await speakTurn(fake);
    await interact(() => fake.setVisible(false));
    await flush();
    expect(phaseOf(composer.container)).toBe('paused');
    await interact(() => fake.setVisible(true));
    await pressAction(composer.container, 'Resume');
    second(fake);
    await speakTurn(fake);
    expect(textarea.value).toBe('Fix the bug. And run tests.');
    await composer.unmount();
  });

  it("what the person typed stays theirs: typed words are never counted as Live's, so a take after them still waits for the person", async () => {
    const { composer, fake, sent } = await rig();
    const textarea = textareaOf(composer.container);
    await typeInto(textarea, 'Please', 'textarea');
    await interact(() => must(liveButton(composer.container), 'the Live button').click());
    await flush();
    await speakTurn(fake);
    expect(textarea.value).toBe('Please Fix the bug.');
    await interact(() => fake.advance(60_000));
    await flush();
    expect(sent.messages).toEqual([]);
    await composer.unmount();
  });

  it('a held sentence the person then edits becomes theirs: the next take is added after their edit', async () => {
    const { composer, fake, sent } = await rig();
    const textarea = textareaOf(composer.container);
    await interact(() => must(liveButton(composer.container), 'the Live button').click());
    await flush();
    await speakTurn(fake);
    await pressAction(composer.container, 'Hold');
    await typeInto(textarea, 'Fix the bug please.', 'textarea');
    await pressAction(composer.container, 'Resume');
    second(fake);
    await speakTurn(fake);
    expect(textarea.value).toBe('Fix the bug please. And run tests.');
    await interact(() => fake.advance(60_000));
    expect(sent.messages).toEqual([]);
    await composer.unmount();
  });
});
