/**
 * The two first-run panels' containers: they read this device's voice store (settings, on-device voices, what the
 * browser can do) and hand the pages `voice-step.tsx` / `speedups-step.tsx` plain props, so the pages stay testable
 * without a store. Each is drawn inside the plugin's `Boundary` (`surfaces.tsx`), which supplies the store.
 */

import { useMemo } from 'react';
import { useSttSettings } from '../../hooks/use-stt-settings.ts';
import { browserRecognitionProvider } from '../../lib/stt/browser-recognition.ts';
import { type DeviceClassGlobalLike, deviceClassOf } from '../../lib/stt/engine-defaults.ts';
import type { SttSettingsStore } from '../../lib/stt/stt-settings.ts';
import { useOnDeviceVoices, useSttSettingsStore } from '../../lib/voice-store.tsx';
import type { DaemonConnection } from '../../shell-voice.ts';
import { VoiceModeSetup } from './voice-mode-setup.tsx';
import { SpeedupsStep } from './speedups-step.tsx';
import type { StepHost } from '@ferretry/kernel/contract';
import { VoiceStep } from './voice-step.tsx';

function VoiceStepWithStore({
  store,
  step,
  daemon,
}: {
  readonly store: SttSettingsStore;
  readonly step?: StepHost | undefined;
  readonly daemon: DaemonConnection | undefined;
}) {
  const { settings, update } = useSttSettings(store);
  const voices = useOnDeviceVoices();
  const provider = useMemo(() => browserRecognitionProvider(), []);
  const support = provider.support;
  const deviceClass = useMemo(() => deviceClassOf(globalThis as DeviceClassGlobalLike), []);
  return (
    <VoiceStep
      settings={settings}
      update={update}
      persisted={() => store.persisted}
      voices={voices}
      browserSupport={support}
      deviceClass={deviceClass}
      step={step}
      voiceMode={daemon === undefined ? undefined : <VoiceModeSetup connection={daemon} />}
    />
  );
}

/** `daemon` is the machine this page's voice mode is set up on (the one the shell's client is for); left out, the page is the device's dictation alone. */
export function VoiceStepContainer({
  step,
  daemon,
}: {
  readonly step?: StepHost | undefined;
  readonly daemon?: DaemonConnection | undefined;
}) {
  const store = useSttSettingsStore();
  return store === null ? null : <VoiceStepWithStore store={store} step={step} daemon={daemon} />;
}

function SpeedupsStepWithStore({
  store,
  step,
}: {
  readonly store: SttSettingsStore;
  readonly step?: StepHost | undefined;
}) {
  const { settings } = useSttSettings(store);
  return <SpeedupsStep settings={settings} step={step} />;
}

export function SpeedupsStepContainer({ step }: { readonly step?: StepHost | undefined }) {
  const store = useSttSettingsStore();
  return store === null ? null : <SpeedupsStepWithStore store={store} step={step} />;
}
