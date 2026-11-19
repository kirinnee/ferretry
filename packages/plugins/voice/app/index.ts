import { forSubject } from '@ferretry/app';
import type { AppComponent, PanelProps } from '@ferretry/kernel/manifest';
import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { voiceSurfaces } from './surfaces.tsx';

/**
 * Voice's app half (§2.3): the Voice and Speed-ups settings tabs, the composer's dictation control, "Read aloud" in an
 * assistant message's footer, "Read replies aloud" above the composer, and the first run's two client steps: Voice ("How should this device hear you?", the engine cards) and Speed-ups
 * (the device-held keys, only after a local engine was picked), each drawn only for its own step.
 */
export default implementApp(manifest, {
  build: ({ client }) => {
    const { VoiceTab, SpeedupsTab, DictationPanel, ReadAloudPanel, AutoReadPanel, VoiceStepPanel, SpeedupsStepPanel } =
      voiceSurfaces(client, {
        loadSpeechAssets: async () => (await import('./speech-assets.ts')).speechAssets,
      });
    return {
      settings: { voice: VoiceTab, speedups: SpeedupsTab },
      panels: {
        dictation: DictationPanel,
        'read-aloud': ReadAloudPanel,
        'auto-read': AutoReadPanel,
        'onboarding-speedups': forSubject('voice.speedups', SpeedupsStepPanel as AppComponent<PanelProps>),
        'onboarding-voice': forSubject('voice.voice', VoiceStepPanel as AppComponent<PanelProps>),
      },
    };
  },
});
