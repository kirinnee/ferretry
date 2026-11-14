import { forSubject } from '@ferretry/app';
import type { AppComponent, PanelProps } from '@ferretry/kernel/manifest';
import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { voiceSurfaces } from './surfaces.tsx';

/**
 * Voice's app half (§2.3): the Voice and Speed-ups settings tabs, the composer's dictation control, "Read aloud" in an
 * assistant message's footer, and the first run's Speed-ups and Voice steps (the same views as the two tabs, each drawn
 * only for its own step).
 */
export default implementApp(manifest, {
  build: ({ client }) => {
    const { VoiceTab, SpeedupsTab, DictationPanel, ReadAloudPanel } = voiceSurfaces(client);
    return {
      settings: { voice: VoiceTab, speedups: SpeedupsTab },
      panels: {
        dictation: DictationPanel,
        'read-aloud': ReadAloudPanel,
        'onboarding-speedups': forSubject('voice.speedups', SpeedupsTab as AppComponent<PanelProps>),
        'onboarding-voice': forSubject('voice.voice', VoiceTab as AppComponent<PanelProps>),
      },
    };
  },
});
