import { afterEach, describe, expect, test } from 'bun:test';
import { LiveVoiceSettingsProvider } from '../../../app/hooks/use-live-voice-settings.ts';
import { ReadAloudProvider } from '../../../app/hooks/use-read-aloud.ts';
import { LiveVoiceSettingsStore } from '../../../app/lib/voice-chat/live-settings.ts';
import { createReadAloud } from '../../../app/lib/voice-chat/read-aloud.ts';
import { createSpeechSynthesisSpeaker } from '../../../app/lib/voice-chat/speech-synthesis.ts';
import { voiceSurfaces } from '../../../app/surfaces.tsx';
import { interact, type Mounted, mount } from '../../support/app/dom.ts';
import { FakeSynth, FakeUtterance, voice } from '../../support/app/fake-speech.ts';

/**
 * "Read aloud" as the panel Voice contributes to Conversation's `conversation.row-actions` slot. The button is OPT-IN
 * (r11 S12): nothing is drawn until this device turns "Show Read aloud on each reply" on.
 */

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

const controller = () =>
  createReadAloud({
    speaker: createSpeechSynthesisSpeaker({
      synth: new FakeSynth([voice('Samantha', 'en-US', { isDefault: true })]),
      createUtterance: text => new FakeUtterance(text),
    }),
    language: () => 'en-US',
  });

const memory = () => {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
};

/** A fresh device by default (no stored settings); `on` is a device that turned the button on. */
const draw = async (
  kind: 'assistant' | 'user' | 'tool',
  text: string,
  on = true,
  store = new LiveVoiceSettingsStore(memory()),
) => {
  if (on) store.update({ readAloudButton: true });
  const { ReadAloudPanel } = voiceSurfaces({ call: async () => ({}) } as never);
  mounted = await mount(
    <LiveVoiceSettingsProvider store={store}>
      <ReadAloudProvider controller={controller()}>
        <ReadAloudPanel entry={{ id: 'row-1', kind, text }} subject="shared" />
      </ReadAloudProvider>
    </LiveVoiceSettingsProvider>,
  );
  return { root: mounted.container, store };
};

describe('the Read aloud panel in an assistant message’s footer', () => {
  test('with the setting on, an assistant message gets a Read aloud button', async () => {
    const { root } = await draw('assistant', 'The fix is in. Run the tests next.');
    expect(root.querySelector('.fy-read-aloud-button')?.textContent).toBe('Read aloud');
  });

  test('r11 S12: on a fresh device (nothing stored) there is no Read aloud button at all', async () => {
    const { root } = await draw('assistant', 'The fix is in. Run the tests next.', false);
    expect(root.innerHTML).toBe('');
    expect(root.textContent).not.toContain('Read aloud');
  });

  test('r11 S12: turning the setting on draws the button, and turning it off takes it away again', async () => {
    const { root, store } = await draw('assistant', 'The fix is in. Run the tests next.', false);
    expect(root.querySelector('.fy-read-aloud-button')).toBeNull();
    await interact(() => store.update({ readAloudButton: true }));
    expect(root.querySelector('.fy-read-aloud-button')?.textContent).toBe('Read aloud');
    await interact(() => store.update({ readAloudButton: false }));
    expect(root.querySelector('.fy-read-aloud-button')).toBeNull();
  });

  test('a message of the person’s, or a tool row, gets nothing', async () => {
    expect((await draw('user', 'The fix is in.')).root.innerHTML).toBe('');
    await mounted?.unmount();
    expect((await draw('tool', 'ran a tool')).root.innerHTML).toBe('');
  });

  test('without a row it draws nothing', async () => {
    const { ReadAloudPanel } = voiceSurfaces({ call: async () => ({}) } as never);
    mounted = await mount(<ReadAloudPanel subject="shared" />);
    expect(mounted.container.innerHTML).toBe('');
  });
});
