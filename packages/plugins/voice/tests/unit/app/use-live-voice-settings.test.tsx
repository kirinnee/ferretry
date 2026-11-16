import { afterEach, describe, expect, test } from 'bun:test';
import { LiveVoiceSettingsProvider, useLiveVoiceSettings } from '../../../app/hooks/use-live-voice-settings.ts';
import { LIVE_VOICE_SETTINGS_KEY, LiveVoiceSettingsStore } from '../../../app/lib/voice-chat/live-settings.ts';
import { interact, type Mounted, mount } from '../../support/app/dom.ts';

/** The settings binding: it follows another tab's write through the `storage` event, and a screen with no store reads the defaults. */

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

const memory = () => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
};

function Probe({ store }: { readonly store: LiveVoiceSettingsStore | null }) {
  const { settings, update, persisted } = useLiveVoiceSettings(store);
  return (
    <button
      data-on={String(settings.autoRead)}
      data-persisted={String(persisted)}
      onClick={() => update({ autoRead: true })}
      type="button"
    >
      {settings.whatToRead}
    </button>
  );
}

const button = (root: HTMLElement): HTMLButtonElement => root.querySelector('button') as HTMLButtonElement;
const storageEvent = (key: string | null): void => {
  window.dispatchEvent(new StorageEvent('storage', { key }));
};

describe('useLiveVoiceSettings', () => {
  test("another tab's write to the settings key, or a whole-storage clear, is picked up; other keys are not", async () => {
    const storage = memory();
    const store = new LiveVoiceSettingsStore(storage);
    mounted = await mount(
      <LiveVoiceSettingsProvider store={store}>
        <Probe store={store} />
      </LiveVoiceSettingsProvider>,
    );
    const root = mounted.container;
    expect(button(root).textContent).toBe('last');
    storage.data.set(LIVE_VOICE_SETTINGS_KEY, JSON.stringify({ format: 1, whatToRead: 'every' }));
    await interact(() => storageEvent('some-other-key'));
    expect(button(root).textContent).toBe('last');
    await interact(() => storageEvent(LIVE_VOICE_SETTINGS_KEY));
    expect(button(root).textContent).toBe('every');
    storage.data.set(LIVE_VOICE_SETTINGS_KEY, JSON.stringify({ format: 1, whatToRead: 'last' }));
    await interact(() => storageEvent(null));
    expect(button(root).textContent).toBe('last');
  });

  test('with no store the defaults show, a write goes nowhere and nothing claims it was refused', async () => {
    mounted = await mount(<Probe store={null} />);
    const root = mounted.container;
    expect(button(root).dataset['on']).toBe('false');
    expect(button(root).dataset['persisted']).toBe('true');
    await interact(() => button(root).click());
    expect(button(root).dataset['on']).toBe('false');
  });

  test('a write through the hook reaches the store and the screen', async () => {
    const store = new LiveVoiceSettingsStore(memory());
    mounted = await mount(<Probe store={store} />);
    await interact(() => button(mounted?.container as HTMLElement).click());
    expect(store.get().autoRead).toBe(true);
    expect(button(mounted.container).dataset['on']).toBe('true');
  });
});
