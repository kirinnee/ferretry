import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { voiceSurfaces } from './surfaces.tsx';

/** Voice's app half (§2.3): the Voice and Speed-ups settings tabs and the composer's dictation control. */
export default implementApp(manifest, {
  build: ({ client }) => {
    const { VoiceTab, SpeedupsTab, DictationPanel } = voiceSurfaces(client);
    return {
      settings: { voice: VoiceTab, speedups: SpeedupsTab },
      panels: { dictation: DictationPanel },
    };
  },
});
