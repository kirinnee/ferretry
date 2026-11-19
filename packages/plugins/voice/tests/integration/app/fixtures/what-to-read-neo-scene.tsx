/**
 * The browser entry for Voice's "Read replies aloud" settings under a chosen style and palette (`?style=&palette=&mode=`,
 * default neo / neo / light): the REAL `AutoReadSettings` over a fake speech engine that speaks nothing. Its "What to read"
 * group is a radio group of cards whose chosen description is muted text, which Neo's first polish dressed as a Segmented control
 * and dropped to 1.35:1 (r10 T13 fix); `what-to-read-neo.visual.test.ts` holds its text to 4.5:1.
 */
import { createRoot } from 'react-dom/client';
import { AutoReadSettings } from '../../../../app/features/settings/auto-read-settings.tsx';
import { LiveVoiceSettingsProvider } from '../../../../app/hooks/use-live-voice-settings.ts';
import { ReadAloudProvider } from '../../../../app/hooks/use-read-aloud.ts';
import { LiveVoiceSettingsStore } from '../../../../app/lib/voice-chat/live-settings.ts';
import { createReadAloud } from '../../../../app/lib/voice-chat/read-aloud.ts';
import { createSpeechSynthesisSpeaker } from '../../../../app/lib/voice-chat/speech-synthesis.ts';

const params = new URLSearchParams(window.location.search);
const root = document.documentElement;
root.dataset.style = params.get('style') ?? 'neo';
root.dataset.palette = params.get('palette') ?? 'neo';
root.dataset.mode = params.get('mode') ?? 'light';

const noop = () => undefined;
const store = new LiveVoiceSettingsStore({ getItem: () => null, setItem: noop });
const controller = createReadAloud({
  speaker: createSpeechSynthesisSpeaker({
    synth: {
      speak: noop,
      cancel: noop,
      getVoices: () => [{ voiceURI: 'uri:Fake', name: 'Fake voice', lang: 'en-US', localService: true, default: true }],
    },
    createUtterance: text => ({
      text,
      rate: 1,
      volume: 1,
      lang: '',
      voice: null,
      onstart: null,
      onend: null,
      onerror: null,
    }),
  }),
  language: () => 'en-US',
});

createRoot(document.getElementById('root') as HTMLElement).render(
  <main className="bg-bg text-fg" data-scene="" style={{ minHeight: '100vh', padding: 16, maxWidth: 720 }}>
    <LiveVoiceSettingsProvider store={store}>
      <ReadAloudProvider controller={controller}>
        <AutoReadSettings />
      </ReadAloudProvider>
    </LiveVoiceSettingsProvider>
  </main>,
);
