import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { voiceSurfaces } from './surfaces.tsx';

/** Voice's app half (§2.3): the Voice and Speed-ups settings tabs, the composer's dictation control and "Read aloud" in an assistant message's footer. */
export default implementApp(manifest, {
  build: ({ client }) => {
    const { VoiceTab, SpeedupsTab, DictationPanel, ReadAloudPanel } = voiceSurfaces(client);
    return {
      settings: { voice: VoiceTab, speedups: SpeedupsTab },
      panels: { dictation: DictationPanel, 'read-aloud': ReadAloudPanel },
    };
  },
});
