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
import { SpeedupsStep } from './speedups-step.tsx';
import type { StepHost } from './step-host.ts';
import { VoiceStep } from './voice-step.tsx';

/** The host the shell put on the panel's props, if any. The shell's `PanelProps.step` is typed once O1 lands. */
export const stepOf = (props: object): StepHost | undefined => (props as { readonly step?: StepHost }).step;

function VoiceStepWithStore({
  store,
  step,
}: {
  readonly store: SttSettingsStore;
  readonly step?: StepHost | undefined;
}) {
  const { settings, update } = useSttSettings(store);
  const voices = useOnDeviceVoices();
  const support = useMemo(() => browserRecognitionProvider().support, []);
  const deviceClass = useMemo(() => deviceClassOf(globalThis as DeviceClassGlobalLike), []);
  return (
    <VoiceStep
      settings={settings}
      update={update}
      voices={voices}
      browserSupport={support}
      deviceClass={deviceClass}
      step={step}
    />
  );
}

export function VoiceStepContainer({ step }: { readonly step?: StepHost | undefined }) {
  const store = useSttSettingsStore();
  return store === null ? null : <VoiceStepWithStore store={store} step={step} />;
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
