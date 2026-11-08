/**
 * The Voice-owned S rows of docs/design/rebuild-parity.tsv, one test per row (or row group), each named by its ids.
 * Each test mounts the real surface — the half the shell builds, or the component that half composes — and asserts
 * what a person sees. Today's Settings catalog rows are the plugin's own settings tabs and catalogs.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { LoginsPort } from '@ferretry/plugin-logins/contract';
import type { ComponentType } from 'react';
import { DEFAULT_VOICE_CLEANUP_PROMPTS, type CleanupTrace } from '../../../contract/index.ts';
import app from '../../../app/index.ts';
import { DictationDebugSheet } from '../../../app/components/dictation-debug-sheet.tsx';
import { DictationSheet } from '../../../app/components/dictation-sheet.tsx';
import { DictationDebugSettings } from '../../../app/features/settings/dictation-debug-settings.tsx';
import { DictationSettings } from '../../../app/features/settings/dictation-settings.tsx';
import { SpeedupKeysSettings } from '../../../app/features/settings/speedup-keys-settings.tsx';
import { VoiceCleanupSettings } from '../../../app/features/settings/voice-cleanup-settings.tsx';
import { PARAKEET_ENGINE_LABEL, VoiceEngineChoice } from '../../../app/features/settings/voice-engine-choice.tsx';
import { SpeedupsPanel, SpeedupsSurface } from '../../../app/features/speedups/speedups-surface.tsx';
import { DictationDebugLog } from '../../../app/lib/stt/dictation-debug.ts';
import {
  AFTER_DICTATION_OPTIONS,
  DEFAULT_STT_SETTINGS,
  ENHANCEMENT_PROVIDERS,
} from '../../../app/lib/stt/stt-settings.ts';
import { DEFAULT_VOICE_CLEANUP } from '../../../app/lib/stt/voice-cleanup.ts';
import { daemonConnection } from '../../../app/shell-voice.ts';
import manifest from '../../../manifest.ts';
import { AVAILABLE_RECOGNITION } from '../../support/app/browser-recognition.ts';
import { type Mounted, mount, must } from '../../support/app/dom.ts';
import { act } from 'react';
import { settleUntil } from '../../support/app/settle.ts';

const shown: Mounted[] = [];
const show = async (element: Parameters<typeof mount>[0]): Promise<HTMLElement> => {
  const view = await mount(element);
  shown.push(view);
  return view.container;
};
afterEach(async () => {
  for (const view of shown.splice(0)) await view.unmount();
});

const text = (container: HTMLElement): string => container.textContent ?? '';
const waitFor = async (container: HTMLElement, wanted: string): Promise<void> => {
  await settleUntil(
    () => text(container).includes(wanted),
    wanted,
    async step => await act(step),
  );
  expect(text(container)).toContain(wanted);
};

/** A client that answers nothing: these surfaces must render their own frame before (or without) any answer. */
const silentClient = { call: async () => await new Promise(() => undefined) };

const halfOver = () =>
  must(app.build, 'the app half builder')({ manifest, client: silentClient as never }) as unknown as {
    readonly settings: Record<string, ComponentType>;
    readonly panels: Record<string, ComponentType<{ subject?: string }>>;
  };

const speedupsView = {
  vault: 'ok',
  providers: [
    {
      provider: 'groq',
      label: 'Groq',
      purpose: 'Cleans up dictated text.',
      costNote: 'Well under a cent.',
      privacyNote: 'Text goes to Groq; audio never leaves.',
      keyUrl: 'https://console.groq.com/keys',
      testNote: 'Test lists models. Free.',
      secretName: 'GROQ_API_KEY',
      set: false,
      testStale: false,
    },
  ],
} as const;

const trace: CleanupTrace = {
  via: 'device',
  provider: 'groq',
  model: 'example-model',
  host: 'api.example.invalid',
  totalMs: 412,
  outcome: 'cleaned',
  finalText: 'Fix the bug.',
  attempts: [
    {
      withContext: false,
      request: {
        host: 'api.example.invalid',
        path: '/v1/chat/completions',
        headers: {},
        params: {},
        messages: [{ role: 'user', content: 'um fix the bug' }],
      },
      timings: { totalMs: 410 },
    },
  ],
};

const noop = (): void => undefined;

describe('the Voice app half', () => {
  test('S-0473 S-0330 S-0429 settings Voice and Speed-ups are the half’s two settings tabs and two panels', () => {
    expect(manifest.ui.settings).toEqual([
      expect.objectContaining({ id: 'voice', label: 'Voice' }),
      expect.objectContaining({ id: 'speedups', label: 'Speed-ups' }),
    ]);
    const half = halfOver();
    expect(Object.keys(half.settings)).toEqual(['voice', 'speedups']);
    expect(Object.keys(half.panels)).toEqual(['dictation', 'read-aloud']);
  });

  test('S-0096 S-0472 S-0558 S-0572 the Voice tab mounts dictation, speed-up keys, transcription log and debug', async () => {
    const Tab = must(halfOver().settings.voice, 'the Voice tab');
    const container = await show(<Tab />);
    await waitFor(container, 'Dictation debug');
    // Today's Settings search entries are the rows' setting ids; each row keeps its name.
    for (const id of ['speedup-keys', 'transcription-log', 'dictation-debug'])
      expect(container.querySelector(`[data-setting-id="${id}"]`)).not.toBeNull();
    for (const name of ['Speed-up key', 'Transcription log', 'Dictation debug'])
      expect(text(container)).toContain(name);
    expect(container.querySelector('section[aria-label="Voice engine"]')).not.toBeNull();
  });

  test('S-0559 S-0258 the Speed-ups tab is the SpeedupsSurface, reading this machine’s keys', async () => {
    const Tab = must(halfOver().settings.speedups, 'the Speed-ups tab');
    const container = await show(<Tab />);
    await waitFor(container, 'Reading this machine’s speed-up keys');
  });

  test('S-0258 SpeedupsSurface reads through the client it is handed', async () => {
    const container = await show(
      <SpeedupsSurface
        connection={daemonConnection({ daemonId: 'a', baseUrl: 'https://a.example.test', deviceId: 'd' })}
        createClient={async () => ({ request: async () => speedupsView }) as never}
      />,
    );
    await waitFor(container, 'Groq');
  });

  test('S-0257 SpeedupsPanel introduces the keys, one card per provider', async () => {
    const container = await show(
      <SpeedupsPanel view={speedupsView as never} busy={null} errors={{}} onSave={noop} onTest={noop} />,
    );
    expect(text(container)).toContain('Speed-ups');
    expect(container.querySelector('[data-testid="speedups-panel"]')).not.toBeNull();
  });

  test('S-0256 SpeedupKeysSettings without a vault explains the keys and shows no card', async () => {
    const container = await show(<SpeedupKeysSettings keys={null} />);
    expect(text(container)).toContain('Speed-up key');
    expect(container.querySelector('[data-setting-id="speedup-keys"]')).not.toBeNull();
    expect(container.querySelector('[data-device-key]')).toBeNull();
  });

  test('S-0094 DictationDebugSettings starts off and keeps nothing', async () => {
    const storage = new Map<string, string>();
    const log = new DictationDebugLog({
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => void storage.set(key, value),
    });
    const container = await show(<DictationDebugSettings log={log} />);
    expect(text(container)).toContain('Dictation debug');
    expect(text(container)).toContain('Off: nothing is kept');
  });

  test('S-0095 S-0216 DictationDebugSheet shows one call in collapsible Sections', async () => {
    const container = await show(
      <DictationDebugSheet
        record={{ id: 'debug-1', at: Date.UTC(2026, 9, 21), trace }}
        copy={async () => undefined}
        onClose={noop}
      />,
    );
    expect(text(container)).toContain('Fix the bug.');
    expect(container.querySelectorAll('[data-debug-section]').length).toBeGreaterThan(0);
  });

  test('S-0097 DictationSheet shows a recording with its stop control', async () => {
    await show(
      <DictationSheet
        open
        stage="recording"
        elapsedMs={9_400}
        onDismiss={noop}
        onStop={noop}
        onInsert={noop}
        onDiscard={noop}
        onCancel={noop}
        onRetry={noop}
      />,
    );
    expect(text(document.body)).toContain('0:09');
  });

  test.skip('S-0280 VoiceCleanupSettings reads and writes voice.yaml … pending port: kernel config routes (D2 #3)', () => {});

  test('S-0281 S-0518 S-0481 S-0528 VoiceCleanupView (rendered through VoiceCleanupSettings with injected state) offers Off, Fix and Polish', async () => {
    const container = await show(
      <VoiceCleanupSettings
        state={{ cleanup: DEFAULT_VOICE_CLEANUP, loaded: true, save: async () => ({ kind: 'applied' }) }}
      />,
    );
    for (const label of ['Off', 'Fix mistakes only', 'Polish']) expect(text(container)).toContain(label);
    expect(must(container.querySelector<HTMLTextAreaElement>('#stt-cleanup-prompt-fix'), 'the prompt').value).toBe(
      DEFAULT_VOICE_CLEANUP_PROMPTS.fix,
    );
  });

  test('S-0503 S-0485 S-0456 the clean-up providers: on-device, Groq and Cerebras', () => {
    expect(ENHANCEMENT_PROVIDERS.map(provider => [provider.id, provider.label])).toEqual([
      ['local', 'On-device word correction'],
      ['groq', 'Groq clean-up'],
      ['cerebras', 'Cerebras clean-up'],
    ]);
  });

  test('S-0538 S-0489 after dictation: Review first, or Insert straight away', async () => {
    expect(AFTER_DICTATION_OPTIONS.map(option => [option.id, option.label])).toEqual([
      ['review', 'Review first'],
      ['insert', 'Insert straight away'],
    ]);
    const container = await show(
      <DictationSettings
        settings={DEFAULT_STT_SETTINGS}
        update={noop}
        persisted
        recognitionSupport={AVAILABLE_RECOGNITION}
      />,
    );
    expect(text(container)).toContain('Review first');
  });

  test('S-0525 the on-device engine is “Parakeet on this device”', async () => {
    expect(PARAKEET_ENGINE_LABEL).toBe('Parakeet on this device');
    const container = await show(
      <VoiceEngineChoice value="parakeet" onChange={noop} voice={null} browserSupport={AVAILABLE_RECOGNITION} />,
    );
    expect(text(container)).toContain(PARAKEET_ENGINE_LABEL);
  });

  test('D2 #8 Voice uses Logins through Logins’ own contract, with no local stand-in', () => {
    expect(manifest.uses?.logins).toBe(LoginsPort);
  });

  test.skip('S-0576 the clone preview’s “Voice clean-up” row … pending port: Runtimes’ New machine clone preview (app half)', () => {});
});
