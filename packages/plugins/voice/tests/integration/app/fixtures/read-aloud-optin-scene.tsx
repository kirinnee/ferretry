/**
 * The browser entry for r11 S12 (Read aloud is opt-in): ONE page, two views over the SAME browser storage, so a switch turned on in
 * Settings is read back in the chat after a navigation, exactly as a person would meet it.
 *
 *   ?view=chat       three assistant messages, each with Voice's real `conversation.row-actions` panel (`ReadAloudPanel`)
 *   ?view=settings   the real Voice › Read replies aloud section (`AutoReadSettings`), including "Show Read aloud on each reply"
 *   ?older=1         with `view=settings`: the connected computer is known to run an older Ferretry (the note names the switch)
 *   ?theme=<family>-<mode>
 *
 * The voice is a fake that speaks nothing; the storage is the browser's own `localStorage` (the real `fy:voice:live-settings` key).
 * Everything on screen is made up.
 */
import { createRoot } from 'react-dom/client';
import { AutoReadSettings } from '../../../../app/features/settings/auto-read-settings.tsx';
import { ReadAloudProvider } from '../../../../app/hooks/use-read-aloud.ts';
import { createReadAloud } from '../../../../app/lib/voice-chat/read-aloud.ts';
import { createSpeechSynthesisSpeaker } from '../../../../app/lib/voice-chat/speech-synthesis.ts';
import { createVoiceStore, StoreProvider } from '../../../../app/lib/voice-store.tsx';
import { voiceSurfaces } from '../../../../app/surfaces.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const view = params.get('view') === 'settings' ? 'settings' : 'chat';

const noop = () => undefined;
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

const MESSAGES = [
  { id: 'a1', text: 'I found the bug: the retry loop never resets its counter. The fix is one line.' },
  { id: 'a2', text: 'Tests pass now. I also added a regression test for the counter reset.' },
  { id: 'a3', text: 'Ready for review. Nothing else is left on my side.' },
] as const;

const { ReadAloudPanel } = voiceSurfaces({ call: async () => ({}) } as never);

function Chat() {
  return (
    <ReadAloudProvider controller={controller}>
      <ol data-chat="" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 16 }}>
        {MESSAGES.map(message => (
          <li data-message="" key={message.id}>
            <p>{message.text}</p>
            <footer data-row-actions="">
              <ReadAloudPanel entry={{ id: message.id, kind: 'assistant', text: message.text }} subject="shared" />
            </footer>
          </li>
        ))}
      </ol>
    </ReadAloudProvider>
  );
}

const store = createVoiceStore({});

createRoot(document.getElementById('root') as HTMLElement).render(
  <main className="bg-bg text-fg" data-scene="" style={{ minHeight: '100vh', padding: 16, maxWidth: 720 }}>
    {view === 'chat' ? (
      <Chat />
    ) : (
      <StoreProvider store={store}>
        <ReadAloudProvider controller={controller}>
          <div className="fy-vs">
            <AutoReadSettings olderMachine={params.get('older') === '1'} />
          </div>
        </ReadAloudProvider>
      </StoreProvider>
    )}
  </main>,
);
