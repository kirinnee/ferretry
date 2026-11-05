import { afterEach, describe, expect, test } from 'bun:test';
import { AutoReadSettings } from '../../src/features/settings/auto-read-settings.tsx';
import { LiveVoiceSettingsProvider } from '../../src/hooks/use-live-voice-settings.ts';
import { ReadAloudProvider } from '../../src/hooks/use-read-aloud.ts';
import { LiveVoiceSettingsStore } from '../../src/lib/voice-chat/live-settings.ts';
import { createReadAloud, type ReadAloudController } from '../../src/lib/voice-chat/read-aloud.ts';
import { createSpeechSynthesisSpeaker } from '../../src/lib/voice-chat/speech-synthesis.ts';
import { interact, type Mounted, mount, must } from '../support/dom.ts';
import { FakeSynth, FakeUtterance, voice } from '../support/fake-speech.ts';

/** Settings › This device › Voice › Read replies aloud: every control, in words, over a fake voice. */

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

const rig = (
  voices = [voice('Samantha', 'en-US', { isDefault: true }), voice('Google US English', 'en-US', { local: false })],
) => {
  const synth = new FakeSynth(voices);
  const speaker = createSpeechSynthesisSpeaker({ synth, createUtterance: text => new FakeUtterance(text) });
  const controller: ReadAloudController = createReadAloud({ speaker, language: () => 'en-US' });
  const storage = memory();
  const store = new LiveVoiceSettingsStore(storage);
  return { synth, controller, store, storage };
};

const show = async (r: { controller: ReadAloudController; store: LiveVoiceSettingsStore }) => {
  mounted = await mount(
    <LiveVoiceSettingsProvider store={r.store}>
      <ReadAloudProvider controller={r.controller}>
        <AutoReadSettings />
      </ReadAloudProvider>
    </LiveVoiceSettingsProvider>,
  );
  return mounted.container;
};

const byId = <T extends HTMLElement>(root: HTMLElement, id: string): T => must(root.querySelector<T>(`#${id}`), id);
const change = async (element: HTMLElement, value: string): Promise<void> => {
  await interact(() => {
    // React tracks an input's value through the prototype's setter, so a plain assignment would be ignored.
    const proto = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
};

describe('<AutoReadSettings>', () => {
  test('the section is badged "This device" and starts OFF, saying so in words', async () => {
    const root = await show(rig());
    expect(root.querySelector('h4')?.textContent).toBe('Read replies aloud');
    expect(root.textContent).toContain('This device');
    const toggle = must(root.querySelector<HTMLElement>('[role="switch"]'), 'the switch');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(toggle.textContent).toContain('Auto-read replies');
    expect(toggle.textContent).toContain('Off');
    expect(root.textContent).toContain('Off by default.');
    expect(root.textContent).toContain('Replies are spoken with the voices built into this device.');
  });

  test('turning it on saves to this device, says On, and explains what is read and how to stop', async () => {
    const r = rig();
    const root = await show(r);
    await interact(() => must(root.querySelector<HTMLElement>('[role="switch"]'), 'switch').click());
    expect(r.store.get().autoRead).toBe(true);
    expect(JSON.parse(r.storage.data.get('fy-live-voice-v1') ?? '{}')).toMatchObject({ v: 1, autoRead: true });
    const toggle = must(root.querySelector<HTMLElement>('[role="switch"]'), 'switch');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(toggle.textContent).toContain('On');
    expect(root.textContent).toContain('Tap anywhere or press a key to stop.');
    expect(root.textContent).toContain('The microphone is never used.');
    expect(root.textContent).toContain('older Ferretry');
  });

  test('the voice list groups voices by where they speak and labels the ones that send text away', async () => {
    const root = await show(rig());
    const select = byId<HTMLSelectElement>(root, 'auto-read-voice');
    const groups = [...select.querySelectorAll('optgroup')].map(group => group.getAttribute('label'));
    expect(groups).toEqual(['On this device', 'Sends text away']);
    const labels = [...select.querySelectorAll('option')].map(option => option.textContent);
    expect(labels).toEqual([
      'Best voice for this device',
      'Samantha — en-US',
      'Google US English (sends text away) — en-US',
    ]);
    expect(select.value).toBe('best');
  });

  test('choosing a voice is saved; a remote one warns in words; "best" clears it', async () => {
    const r = rig();
    const root = await show(r);
    const select = byId<HTMLSelectElement>(root, 'auto-read-voice');
    await change(select, 'uri:Google US English');
    expect(r.store.get().voiceId).toBe('uri:Google US English');
    expect(root.textContent).toContain('Google US English sends the text of each reply to its maker to be spoken.');
    await change(select, 'uri:Samantha');
    expect(r.store.get().voiceId).toBe('uri:Samantha');
    expect(root.textContent).not.toContain('sends the text of each reply');
    await change(select, 'best');
    expect(r.store.get().voiceId).toBeNull();
  });

  test('a stored voice this device no longer has falls back, and says so', async () => {
    const r = rig();
    r.store.update({ voiceId: 'uri:Gone' });
    const root = await show(r);
    expect(byId<HTMLSelectElement>(root, 'auto-read-voice').value).toBe('best');
    expect(root.textContent).toContain('The voice you chose is not on this device any more');
  });

  test('Preview speaks one sentence with the chosen voice and speed, and flips to "Stop preview"', async () => {
    const r = rig();
    r.store.update({ voiceId: 'uri:Samantha', rate: 1.7 });
    const root = await show(r);
    const preview = must(root.querySelector<HTMLButtonElement>('[data-preview]'), 'Preview');
    expect(preview.textContent).toBe('Preview voice');
    await interact(() => preview.click());
    expect(r.synth.spoken[0]?.text).toBe('This is how a reply will sound.');
    expect(r.synth.spoken[0]?.rate).toBe(1.7);
    expect(preview.textContent).toBe('Stop preview');
    await interact(() => preview.click());
    expect(r.controller.getState().status).toBe('stopped');
    expect(preview.textContent).toBe('Preview voice');
  });

  test('a preview that ends by itself puts the button back; leaving the screen silences a preview still going', async () => {
    const r = rig();
    const root = await show(r);
    const preview = must(root.querySelector<HTMLButtonElement>('[data-preview]'), 'Preview');
    await interact(() => preview.click());
    await interact(() => r.synth.play());
    expect(preview.textContent).toBe('Preview voice');
    await interact(() => preview.click());
    expect(r.controller.getState().status).toBe('reading');
    await mounted?.unmount();
    mounted = null;
    expect(r.controller.getState().status).toBe('stopped');
  });

  test('speed: a labelled slider from 0.8 to 2.0 that saves and reads out its value', async () => {
    const r = rig();
    const root = await show(r);
    const slider = byId<HTMLInputElement>(root, 'auto-read-rate');
    expect([slider.min, slider.max, slider.step]).toEqual(['0.8', '2', '0.1']);
    expect(root.querySelector('output')?.textContent).toBe('1.1×');
    await change(slider, '1.8');
    expect(r.store.get().rate).toBe(1.8);
    expect(root.querySelector('output')?.textContent).toBe('1.8×');
    expect(slider.getAttribute('aria-valuetext')).toBe('1.8× normal speed');
  });

  test('longest reading: 30 seconds up to no limit', async () => {
    const r = rig();
    const root = await show(r);
    const select = byId<HTMLSelectElement>(root, 'auto-read-length');
    expect([...select.options].map(option => option.textContent)).toEqual([
      '30 seconds',
      '1 minute',
      '2 minutes',
      '5 minutes',
      'No limit',
    ]);
    expect(select.value).toBe('60');
    await change(select, 'none');
    expect(r.store.get().maxSeconds).toBeNull();
    await change(select, '30');
    expect(r.store.get().maxSeconds).toBe(30);
  });

  test('what to read: last message by default, every message by choice', async () => {
    const r = rig();
    const root = await show(r);
    const radios = [...root.querySelectorAll<HTMLInputElement>('input[name="auto-read-what"]')];
    expect(radios.map(radio => radio.checked)).toEqual([true, false]);
    expect(root.textContent).toContain('Last message of the turn');
    await interact(() => radios[1]?.click());
    expect(r.store.get().whatToRead).toBe('every');
  });

  test('before the device lists any voice it says so, and the speed and switch still work', async () => {
    const r = rig([]);
    const root = await show(r);
    expect(root.textContent).toContain('This device has not listed its voices yet.');
    expect(byId<HTMLSelectElement>(root, 'auto-read-voice').options).toHaveLength(1);
  });

  test('a browser with no speech says so and offers no controls', async () => {
    const synth = new FakeSynth([]);
    const none = createReadAloud({
      speaker: {
        ...createSpeechSynthesisSpeaker({ synth, createUtterance: t => new FakeUtterance(t) }),
        supported: false,
      },
    });
    const root = await show({ controller: none, store: new LiveVoiceSettingsStore(memory()) });
    expect(root.textContent).toContain('This browser has no built-in voice');
    expect(root.querySelector('[role="switch"]')).toBeNull();
  });

  test('refused storage is said in words', async () => {
    const synth = new FakeSynth([voice('Samantha', 'en-US', { isDefault: true })]);
    const controller = createReadAloud({
      speaker: createSpeechSynthesisSpeaker({ synth, createUtterance: t => new FakeUtterance(t) }),
    });
    const store = new LiveVoiceSettingsStore(memory(true));
    const root = await show({ controller, store });
    expect(root.textContent).not.toContain('could not be saved');
    await interact(() => must(root.querySelector<HTMLElement>('[role="switch"]'), 'switch').click());
    expect(root.textContent).toContain('These choices could not be saved');
  });

  test('without any store the screen still renders on the defaults', async () => {
    mounted = await mount(<AutoReadSettings store={null} />);
    expect(mounted.container.querySelector('h4, p')).not.toBeNull();
  });
});
