import { afterEach, describe, expect, test } from 'bun:test';
import { AutoReadSettings } from '../../src/features/settings/auto-read-settings.tsx';
import {
  LIVE_VOICE_INTRO,
  LiveVoiceSettingsSection,
  SCREEN_READER_HINT,
} from '../../src/features/settings/live-voice-settings.tsx';
import { LiveVoiceSettingsProvider } from '../../src/hooks/use-live-voice-settings.ts';
import { ReadAloudProvider } from '../../src/hooks/use-read-aloud.ts';
import { LiveVoiceSettingsStore } from '../../src/lib/voice-chat/live-settings.ts';
import { createReadAloud, type ReadAloudController } from '../../src/lib/voice-chat/read-aloud.ts';
import { createSpeechSynthesisSpeaker } from '../../src/lib/voice-chat/speech-synthesis.ts';
import { interact, type Mounted, mount, must } from '../support/dom.ts';
import { FakeSynth, FakeUtterance, voice } from '../support/fake-speech.ts';

/** Settings › Behaviour › Live voice: every control, in words, over a fake voice. */

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

const memory = (fail = false) => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (fail) throw new Error('quota');
      data.set(key, value);
    },
  };
};

const rig = (voices = [voice('Samantha', 'en-US', { isDefault: true }), voice('Daniel', 'en-GB')], fail = false) => {
  const synth = new FakeSynth(voices);
  const speaker = createSpeechSynthesisSpeaker({ synth, createUtterance: text => new FakeUtterance(text) });
  const controller: ReadAloudController = createReadAloud({ speaker, language: () => 'en-US' });
  const storage = memory(fail);
  const store = new LiveVoiceSettingsStore(storage);
  return { controller, store, storage };
};

const show = async (
  r: { controller: ReadAloudController; store: LiveVoiceSettingsStore },
  extra: React.ReactNode = null,
) => {
  mounted = await mount(
    <LiveVoiceSettingsProvider store={r.store}>
      <ReadAloudProvider controller={r.controller}>
        {extra}
        <LiveVoiceSettingsSection />
      </ReadAloudProvider>
    </LiveVoiceSettingsProvider>,
  );
  return mounted.container;
};

const pick = <T extends HTMLElement>(root: HTMLElement, selector: string): T =>
  must(root.querySelector<T>(selector), selector);
const change = async (element: HTMLInputElement, value: string): Promise<void> => {
  await interact(() => {
    // React tracks an input's value through the prototype's setter, so a plain assignment would be ignored.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('<LiveVoiceSettingsSection>', () => {
  test('says what Live is, that voice sends only here, and when changes apply', async () => {
    const root = await show(rig());
    expect(root.textContent).toContain(LIVE_VOICE_INTRO);
    expect(root.textContent).toContain('Live is the one place voice sends');
    expect(root.textContent).toContain('apply the next time you press Live');
    expect(root.querySelector('[data-live-voice-settings]')?.getAttribute('aria-label')).toBe('Live voice');
    // Plain words: none of the builder's vocabulary reaches the screen.
    for (const jargon of ['daemon', 'engine', 'endpointer'])
      expect(root.textContent?.toLowerCase()).not.toContain(jargon);
  });

  test('every control is a real one, at least 48 px tall by its class, with its state in words', async () => {
    const root = await show(rig());
    const switches = [...root.querySelectorAll<HTMLElement>('[role="switch"]')];
    expect(switches.map(toggle => toggle.textContent)).toEqual([
      'Send without a countdownOff',
      'Read replies aloud in LiveOn',
      'Keep screen onOn',
      'SoundsOn',
      'Buzz on phonesOn',
    ]);
    for (const toggle of switches) {
      expect(toggle.tagName).toBe('BUTTON');
      expect(toggle.className).toContain('min-h-[48px]');
      expect(toggle.getAttribute('aria-describedby')).not.toBeNull();
    }
    expect(pick(root, 'input[type="range"]').className).toContain('min-h-[48px]');
    for (const button of root.querySelectorAll<HTMLElement>('button:not([role="switch"])'))
      expect(button.className).toContain('min-h-[48px]');
    for (const choice of root.querySelectorAll<HTMLElement>('label:has(input[type="radio"])'))
      expect(choice.className).toContain('min-h-[56px]');
  });

  test('Pause before sending: Normal (1.5 s) is chosen, each choice explains itself, and a choice is saved', async () => {
    const r = rig();
    const root = await show(r);
    const radios = [...root.querySelectorAll<HTMLInputElement>('input[name="live-pause"]')];
    expect(radios.map(radio => radio.checked)).toEqual([false, true, false]);
    const text = root.querySelector('[role="radiogroup"]')?.textContent ?? '';
    expect(text).toContain('Quick · 0.9 s');
    expect(text).toContain('Normal · 1.5 s · chosen');
    expect(text).toContain('Thinker · 2.5 s');
    expect(text).toContain('Sends soon after you stop.');
    expect(text).toContain('so you can stop and think mid-sentence');
    await interact(() => radios[2]?.click());
    expect(r.store.get().pause).toBe('thinker');
    expect(root.querySelector('[role="radiogroup"]')?.textContent).toContain('Thinker · 2.5 s · chosen');
    await interact(() => radios[0]?.click());
    expect(r.store.get().pause).toBe('quick');
    expect(JSON.parse(r.storage.data.get('fy-live-voice-v1') ?? '{}')).toMatchObject({ v: 2, pause: 'quick' });
  });

  test('Countdown before send: a slider from 0.5 to 5 s, 1.5 s to start, saved as you move it', async () => {
    const r = rig();
    const root = await show(r);
    const slider = pick<HTMLInputElement>(root, 'input[type="range"]');
    expect([slider.min, slider.max, slider.step]).toEqual(['500', '5000', '500']);
    expect(root.querySelector('output')?.textContent).toBe('1.5 s');
    expect(root.querySelector('[data-live-countdown-warning]')).toBeNull();
    await change(slider, '3500');
    expect(r.store.get().countdownMs).toBe(3500);
    expect(root.querySelector('output')?.textContent).toBe('3.5 s');
    expect(slider.getAttribute('aria-valuetext')).toBe('3.5 s before it sends');
  });

  test('NO COUNTDOWN is its own switch and sits behind a plain warning; turning it off brings the default back', async () => {
    const r = rig();
    const root = await show(r);
    const none = pick(root, '[data-live-no-countdown]');
    expect(none.getAttribute('aria-checked')).toBe('false');
    expect(root.textContent).toContain('Off by default.');
    await interact(() => none.click());
    expect(r.store.get().countdownMs).toBe(0);
    expect(none.getAttribute('aria-checked')).toBe('true');
    const warning = pick(root, '[data-live-countdown-warning]');
    expect(warning.getAttribute('role')).toBe('alert');
    expect(warning.textContent).toContain('Live will send without a countdown');
    expect(warning.textContent).toContain('You will not have time to press Hold');
    expect(none.getAttribute('aria-describedby')).toBe(warning.id);
    // No slider to drag while it is on.
    expect(root.querySelector('input[type="range"]')).toBeNull();
    await interact(() => none.click());
    expect(r.store.get().countdownMs).toBe(1500);
    expect(root.querySelector('[data-live-countdown-warning]')).toBeNull();
    expect(root.querySelector('input[type="range"]')).not.toBeNull();
  });

  test('a stored 0 shows the warning from the first paint', async () => {
    const r = rig();
    r.store.update({ countdownMs: 0 });
    const root = await show(r);
    expect(root.textContent).toContain('Live will send without a countdown');
  });

  test('Read replies aloud in Live is on, says what that means, and can be turned off', async () => {
    const r = rig();
    const root = await show(r);
    const toggle = pick(root, '[data-live-read]');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(root.textContent).toContain('Live reads the last message out loud');
    expect(root.textContent).toContain('The microphone is off while it reads.');
    await interact(() => toggle.click());
    expect(r.store.get().liveRead).toBe(false);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(root.textContent).toContain('Nothing is read out loud.');
    // The page's own Auto-read replies is a different switch and is untouched.
    expect(r.store.get().autoRead).toBe(false);
  });

  test('a browser with no built-in voice says so next to the switch', async () => {
    const synth = new FakeSynth([]);
    const none = createReadAloud({
      speaker: {
        ...createSpeechSynthesisSpeaker({ synth, createUtterance: t => new FakeUtterance(t) }),
        supported: false,
      },
    });
    const root = await show({ controller: none, store: new LiveVoiceSettingsStore(memory()) });
    expect(root.textContent).toContain('This browser has no built-in voice, so Live shows replies on screen');
    expect(root.querySelector('[data-live-read]')).not.toBeNull();
  });

  test('the screen-reader hint shows once: "Got it" keeps reading on and the hint is gone for good', async () => {
    const r = rig();
    const root = await show(r);
    const hint = pick(root, '[data-live-screen-reader-hint]');
    expect(hint.textContent).toContain(SCREEN_READER_HINT);
    expect(SCREEN_READER_HINT).toBe('Using a screen reader? Turn off Read replies aloud.');
    expect(hint.textContent).toContain('would talk over each other');
    await interact(() => pick(hint, '[data-got-it]').click());
    expect(r.store.get().screenReaderHintSeen).toBe(true);
    expect(r.store.get().liveRead).toBe(true);
    expect(root.querySelector('[data-live-screen-reader-hint]')).toBeNull();
    expect(root.textContent).not.toContain('Using a screen reader?');
  });

  test('"Turn it off" in the hint switches reading off and closes the hint', async () => {
    const r = rig();
    const root = await show(r);
    await interact(() => pick(root, '[data-turn-off]').click());
    expect(r.store.get().liveRead).toBe(false);
    expect(r.store.get().screenReaderHintSeen).toBe(true);
    expect(root.querySelector('[data-live-screen-reader-hint]')).toBeNull();
  });

  test('the hint is not offered when reading is already off', async () => {
    const r = rig();
    r.store.update({ liveRead: false });
    const root = await show(r);
    expect(root.querySelector('[data-live-screen-reader-hint]')).toBeNull();
  });

  test('Voice and speed are shown in words and NOT chosen twice; the link moves to the one picker', async () => {
    const r = rig();
    r.store.update({ voiceId: 'uri:Daniel', rate: 1.4, maxSeconds: 120 });
    const root = await show(r, <AutoReadSettings />);
    const summary = pick(root, '[data-live-reading-summary]');
    expect(summary.textContent).toContain('Daniel');
    expect(summary.textContent).toContain('1.4× speed');
    expect(summary.textContent).toContain('up to 2 minutes');
    // Exactly one voice picker and one speed slider on the page (the Read replies aloud ones).
    expect(root.querySelectorAll('select#auto-read-voice').length).toBe(1);
    expect(root.querySelectorAll('input#auto-read-rate').length).toBe(1);
    expect(root.querySelectorAll('[data-live-voice-settings] select').length).toBe(0);
    const target = pick(root, '#read-replies-aloud');
    let scrolled = 0;
    target.scrollIntoView = () => {
      scrolled += 1;
    };
    await interact(() => pick(summary, '[data-change-voice]').click());
    expect(scrolled).toBe(1);
    expect(document.activeElement).toBe(target);
  });

  test('the summary says the best voice for a device with no pick, "no limit" and an odd stored length', async () => {
    const r = rig();
    r.store.update({ maxSeconds: null });
    const root = await show(r);
    const summary = pick(root, '[data-live-reading-summary]');
    expect(summary.textContent).toContain('Best voice for this device · 1.1× speed · no limit');
    // The change link does nothing, and does not fail, where the picker is not on the page.
    await interact(() => pick(summary, '[data-change-voice]').click());
    await interact(() => void r.store.update({ maxSeconds: 45 }));
    expect(pick(root, '[data-live-reading-summary]').textContent).toContain('45 seconds');
  });

  test('Keep screen on is on, explained, and can be turned off', async () => {
    const r = rig();
    const root = await show(r);
    const toggle = pick(root, '[data-live-awake]');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(root.textContent).toContain('keep the screen on while it is on');
    await interact(() => toggle.click());
    expect(r.store.get().keepAwake).toBe(false);
    expect(root.textContent).toContain('The screen can turn off while Live is on.');
  });

  test('Sounds and Buzz on phones are two switches, on, each saved on its own', async () => {
    const r = rig();
    const root = await show(r);
    const sounds = pick(root, '[data-live-sounds]');
    const buzz = pick(root, '[data-live-buzz]');
    expect(sounds.getAttribute('aria-checked')).toBe('true');
    expect(buzz.getAttribute('aria-checked')).toBe('true');
    expect(root.textContent).toContain('Short tones: rising when Live starts listening');
    expect(root.textContent).toContain('iPhones cannot buzz from a web page.');
    await interact(() => sounds.click());
    expect(r.store.get()).toMatchObject({ earcons: false, haptics: true });
    expect(root.textContent).toContain('Live is silent');
    await interact(() => buzz.click());
    expect(r.store.get()).toMatchObject({ earcons: false, haptics: false });
    expect(root.textContent).toContain('No buzzing.');
    await interact(() => sounds.click());
    expect(r.store.get()).toMatchObject({ earcons: true, haptics: false });
  });

  test('clean-up is a read-only line: Fix, with Polish treated as Fix', async () => {
    const root = await show(rig());
    expect(root.textContent).toContain('Live uses Fix-style clean-up; Polish is treated as Fix.');
    const group = pick(root, '[data-live-group="live-cleanup"]');
    expect(group.querySelector('button, input, select')).toBeNull();
    expect(group.textContent).toContain('3 seconds');
  });

  test('refused storage is said in words', async () => {
    const r = rig(undefined, true);
    const root = await show(r);
    expect(root.textContent).not.toContain('could not be saved');
    await interact(() => pick(root, '[data-live-awake]').click());
    expect(root.textContent).toContain('These choices could not be saved');
  });

  test('without any store the card still renders on the defaults', async () => {
    mounted = await mount(<LiveVoiceSettingsSection store={null} />);
    expect(mounted.container.textContent).toContain('Pause before sending');
  });

  test('a store handed in as a prop is used instead of the app one', async () => {
    const store = new LiveVoiceSettingsStore(memory());
    store.update({ pause: 'quick', countdownMs: 0 });
    mounted = await mount(<LiveVoiceSettingsSection store={store} />);
    expect(mounted.container.textContent).toContain('Quick · 0.9 s · chosen');
    expect(mounted.container.textContent).toContain('Live will send without a countdown');
  });
});
