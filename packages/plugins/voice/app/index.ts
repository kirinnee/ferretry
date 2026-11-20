import { forSubject } from '@ferretry/app';
import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { voiceSurfaces } from './surfaces.tsx';
import { speedupKeyPanel } from './features/speedups/key-row.tsx';

/**
 * Voice's app half (§2.3): the Voice and Speed-ups settings tabs, the composer's dictation control, "Read aloud" in an
 * assistant message's footer, "Read replies aloud" above the composer, and the first run's two client steps: Voice ("How should this device hear you?", the engine cards) and Speed-ups
 * (the device-held keys, only after a local engine was picked), each drawn only for its own step.
 */
export default implementApp(manifest, {
  build: ({ client }) => {
    const {
      VoiceTab,
      VoiceCleanupTab,
      SpeedupsTab,
      DictationPanel,
      ReadAloudPanel,
      AutoReadPanel,
      VoiceStepPanel,
      SpeedupsStepPanel,
    } = voiceSurfaces(client, {
      loadSpeechAssets: async () => (await import('./speech-assets.ts')).speechAssets,
    });
    return {
      settings: { voice: VoiceTab, 'voice-cleanup': VoiceCleanupTab, speedups: SpeedupsTab },
      panels: {
        dictation: DictationPanel,
        'read-aloud': ReadAloudPanel,
        'auto-read': AutoReadPanel,
        'speedup-key': speedupKeyPanel(client),
        'onboarding-speedups': forSubject('voice.speedups', SpeedupsStepPanel),
        'onboarding-voice': forSubject('voice.voice', VoiceStepPanel),
      },
    };
  },
});
