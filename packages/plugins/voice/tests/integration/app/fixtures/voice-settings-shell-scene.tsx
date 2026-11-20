/**
 * The browser entry for Voice's settings INSIDE THE REAL SETTINGS SHELL (r10 S5): the real `App` over one fake machine
 * whose Voice tabs are the plugin's real declarations (`manifest.ts`: Voice, Voice clean-up, Speed-ups, with their
 * scopes) and whose bodies are the plugin's real components over fixed fake data. No daemon, no network, no microphone.
 * Everything on screen is made up.
 *
 *   /d/ws/settings/voice/voice            Voice (this device): dictation, engines, vocabulary, auto-read, device keys
 *   /d/ws/settings/voice/voice-cleanup    Voice clean-up (the machine's prompts)
 *   /d/ws/settings/voice/speedups         Speed-ups (the machine's keys)
 *   ?style=off|fix|polish   the machine's saved clean-up style (default: fix)
 *   ?theme=<family>-<mode>   ?engine=<id>|none   the chosen engine (default: sherpa-zipformer-en; none = a fresh device)   ?off=1  dictation off
 *   ?device=phone|computer   the device class the page reports (default: computer)
 *   ?machine=browser|parakeet   the machine's `voice.yaml` defaultEngine, read through a fake daemon (default: none named)
 *
 * The shell is the real one, so the panel is as wide as a person gets it: at a 768 px window the settings list stands
 * ABOVE the panel and the panel is at least 480 px wide (it was about 212 px when the list sat beside it).
 */

import { useState } from 'react';
import { renderSettingsShell } from '@ferretry/app/testing/settings-shell';
import manifest from '../../../../manifest.ts';
import { DictationDebugSettings } from '../../../../app/features/settings/dictation-debug-settings.tsx';
import { DictationSettings } from '../../../../app/features/settings/dictation-settings.tsx';
import { SpeedupKeysSettings } from '../../../../app/features/settings/speedup-keys-settings.tsx';
import { TranscriptionLogSettings } from '../../../../app/features/settings/transcription-log-settings.tsx';
import { VoiceCleanupSettings } from '../../../../app/features/settings/voice-cleanup-settings.tsx';
import { SpeedupsPanel } from '../../../../app/features/speedups/speedups-surface.tsx';
import { daemonConnection, SettingGroup } from '../../../../app/shell-voice.ts';
import { DaemonClientProvider, StoreProvider, createVoiceStore } from '../../../../app/lib/voice-store.tsx';
import type { DeviceClass } from '../../../../app/lib/stt/engine-defaults.ts';
import { modelDownloadBytes, ON_DEVICE_MODELS } from '../../../../app/lib/stt/model-catalog.ts';
import type { ModelInstaller, ModelInstallOptions, ModelStoreStatus } from '../../../../app/lib/stt/model-store.ts';
import { OnDeviceVoice } from '../../../../app/lib/stt/on-device-voice.ts';
import { OnDeviceVoices } from '../../../../app/lib/stt/on-device-voices.ts';
import {
  DEFAULT_STT_SETTINGS,
  type DictationEngineId,
  type SttSettings,
} from '../../../../app/lib/stt/stt-settings.ts';
import { DEFAULT_VOICE_CLEANUP } from '../../../../app/lib/stt/voice-cleanup.ts';
import { DeviceSpeedupKeys } from '../../../../app/lib/stt/speedup-keys.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const engineParam = params.get('engine') ?? 'sherpa-zipformer-en';
const engine = (engineParam === 'none' ? null : engineParam) as DictationEngineId | null;
const off = params.get('off') === '1';
const machine = params.get('machine');
// The machine's default engine, as `voice.yaml` names it, read through the same route the page uses.
const THIS_DAEMON = daemonConnection({
  daemonId: 'fake-daemon',
  baseUrl: 'https://fake-daemon.invalid',
  deviceId: 'fake-device',
});
const fakeClient = {
  history: async () => [],
  request: async (_path: string, schema: { parse(value: unknown): unknown }) =>
    schema.parse({ text: `defaultEngine: ${machine ?? 'null'}\n`, etag: 'fake' }),
} as never;

class FakeStore implements ModelInstaller {
  readonly totalBytes: number;
  readonly #state: ModelStoreStatus;
  constructor(totalBytes: number, state: ModelStoreStatus) {
    this.totalBytes = totalBytes;
    this.#state = state;
  }
  status(): Promise<ModelStoreStatus> {
    return Promise.resolve(this.#state);
  }
  install(options: ModelInstallOptions = {}): Promise<void> {
    options.onProgress?.({ label: 'Encoder', downloadedBytes: this.totalBytes * 0.42, totalBytes: this.totalBytes });
    return new Promise(() => undefined);
  }
  remove(): Promise<void> {
    return Promise.resolve();
  }
}

// Zipformer is downloaded and Whisper tiny is half-way; every other engine is not installed.
const voices = new OnDeviceVoices(
  ON_DEVICE_MODELS.map(model => {
    const bytes = modelDownloadBytes(model);
    const status: ModelStoreStatus =
      model.id === 'sherpa-zipformer-en'
        ? { state: 'installed', version: 'fake', bytes, installedAt: '2026-10-22T00:00:00.000Z' }
        : { state: 'absent' };
    return new OnDeviceVoice({
      model,
      support: { available: true },
      store: new FakeStore(bytes, status),
      openSession: () => {
        throw new Error('no microphone in a shot');
      },
    });
  }),
);
await voices.refresh();

const deviceClass: DeviceClass = params.get('device') === 'phone' ? 'phone' : 'computer';
const AVAILABLE = { available: true, availability: 'available', implementation: 'standard' } as const;

/** The device keys' own vault, in memory: a saved Groq key ends in "ab", Cerebras has none. */
const records = new Map<string, unknown>();
const deviceKeys = new DeviceSpeedupKeys(
  {
    get: async slot => records.get(slot),
    put: async (slot, value) => void records.set(slot, value),
    delete: async slot => void records.delete(slot),
  },
  crypto.subtle,
  async () => Response.json({ data: [{ id: 'a' }, { id: 'b' }] }),
);
await deviceKeys.save('groq', 'gsk_fake_0123456789abcdefab');

function VoiceBody() {
  const [settings, setSettings] = useState<SttSettings>({
    ...DEFAULT_STT_SETTINGS,
    engine,
    enabled: !off,
    dictionary: ['ferretry = ferretree', 'tmux'],
  });
  return (
    <div className="fy-vs">
      <DictationSettings
        settings={settings}
        update={patch => setSettings(previous => ({ ...previous, ...patch }))}
        persisted
        recognitionSupport={AVAILABLE}
        voices={voices}
        deviceClass={deviceClass}
        {...(machine === null ? {} : { daemon: THIS_DAEMON })}
      />
      <SpeedupKeysSettings keys={deviceKeys} />
      <SettingGroup label="Privacy and debugging">
        <TranscriptionLogSettings />
        <DictationDebugSettings />
      </SettingGroup>
    </div>
  );
}

const cleanupState = {
  cleanup: {
    ...DEFAULT_VOICE_CLEANUP,
    style: (['off', 'fix', 'polish'] as const).find(style => style === params.get('style')) ?? 'fix',
    useConversation: true,
  },
  loaded: true,
  save: async () => ({ kind: 'applied' as const }),
};

const speedupsView = {
  vault: 'ok',
  providers: [
    {
      provider: 'jev',
      label: 'Jev',
      purpose: 'A fast second opinion on a Warden flag.',
      costNote: 'About a tenth of a cent a flag.',
      privacyNote: 'The flagged text goes to Jev; nothing else leaves this machine.',
      keyUrl: 'https://example.invalid/keys',
      testNote: 'Test asks for one tiny decision.',
      secretName: 'JEV_API_KEY',
      set: true,
      testStale: false,
      lastTest: {
        provider: 'jev',
        secretName: 'JEV_API_KEY',
        ok: true,
        code: 'ok',
        message: 'The key works.',
        latencyMs: 212,
        at: '2026-11-19T09:00:00.000Z',
      },
    },
    {
      provider: 'groq',
      label: 'Groq',
      purpose: 'Cleans up dictated text for every device on this machine.',
      costNote: 'Well under a cent a take.',
      privacyNote: 'The recognised text goes to Groq; audio never leaves the device.',
      keyUrl: 'https://console.groq.com/keys',
      testNote: 'Test lists the models your key can use. It is free.',
      secretName: 'GROQ_API_KEY',
      set: false,
      testStale: false,
    },
  ],
} as never;

const noop = (): void => undefined;
const voiceStore = createVoiceStore({});
const bodies = {
  voice: () => (
    <DaemonClientProvider client={async () => fakeClient}>
      <StoreProvider store={voiceStore}>
        <VoiceBody />
      </StoreProvider>
    </DaemonClientProvider>
  ),
  'voice-cleanup': () => (
    <div className="fy-vs">
      <VoiceCleanupSettings state={cleanupState} />
    </div>
  ),
  speedups: () => <SpeedupsPanel view={speedupsView} busy={null} errors={{}} onSave={noop} onTest={noop} />,
};

renderSettingsShell({ manifest, bodies });
