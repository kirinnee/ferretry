import { afterEach, describe, expect, test } from 'bun:test';
import { VoiceModeSettings } from '../../../app/features/settings/voice-mode-settings.tsx';
import { LiveVoiceSettingsProvider } from '../../../app/hooks/use-live-voice-settings.ts';
import { LiveVoiceSettingsStore } from '../../../app/lib/voice-chat/live-settings.ts';
import { daemonConnection } from '../../../app/shell-voice.ts';
import { interact, type Mounted, mount } from '../../support/app/dom.ts';

/**
 * Settings › Voice › Voice mode › "Keep audio on this phone": this device's own choice, kept in this browser. It is there
 * when the machine is reachable AND when it is not (an unreachable machine is exactly when a person wants it).
 */

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

const daemon = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'http://127.0.0.1:1', deviceId: 'token-a' });
const memory = () => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
};
const settle = (): Promise<void> => interact(() => new Promise(resolve => setTimeout(resolve, 20)));

describe('Keep audio on this phone', () => {
  test('with the machine unreachable the switch is still there, off, and turning it on is saved on this device', async () => {
    const storage = memory();
    const store = new LiveVoiceSettingsStore(storage);
    mounted = await mount(
      <LiveVoiceSettingsProvider store={store}>
        <VoiceModeSettings
          connection={daemon}
          createClient={async () => {
            throw new Error('offline');
          }}
        />
      </LiveVoiceSettingsProvider>,
    );
    await settle();
    const row = mounted.container.querySelector('[data-setting-id="voice-mode-on-phone"]');
    expect(row?.textContent).toContain('Keep audio on this phone');
    const toggle = row?.querySelector('[role="switch"]') as HTMLElement;
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(store.get().voiceModeOnPhone).toBe(false);
    await interact(() => toggle.click());
    expect(store.get().voiceModeOnPhone).toBe(true);
    expect([...storage.data.values()].join('')).toContain('"voiceModeOnPhone":true');
    expect(
      (
        mounted.container.querySelector('[data-setting-id="voice-mode-on-phone"] [role="switch"]') as HTMLElement
      ).getAttribute('aria-checked'),
    ).toBe('true');
  });
});
