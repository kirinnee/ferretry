/**
 * The page half of `voice-mode.realworld.test.ts`: the SHIPPED Voice mode (`VoiceModeButton` + `VoiceModeSlot`, with the
 * browser's real microphone `browserMic`) in front of a stand-in composer. The microphone is Chrome's fake device playing
 * a recorded clip; the stream goes over a WebSocket to the test's bridge, which runs the daemon's real `VoiceStream` and
 * the real speech engine. Bundled by the test; never part of the app.
 */
import { createRoot } from 'react-dom/client';
import { VoiceModeButton } from '../../../../app/components/voice-mode-button.tsx';
import { VoiceModeSlot } from '../../../../app/components/voice-mode-panel.tsx';
import { createVoiceModeStore } from '../../../../app/lib/voice-mode/voice-mode-store.ts';

const page = globalThis as unknown as {
  __log: { at: number; what: string }[];
  __bridge: string;
};
page.__log = [];
const mark = (what: string): void => void page.__log.push({ at: performance.now(), what });

const view = {
  state: 'ready',
  machine: 'this box',
  label: 'Parakeet TDT 0.6B v3 (int8) with Silero voice detection',
  sizeBytes: 698_905_830,
  doneBytes: 698_905_830,
  loaded: false,
};

const client = {
  call: async () => view,
  socket: (
    _route: string,
    _params: unknown,
    listeners: {
      onOpen?: () => void;
      onFrame: (frame: string | Uint8Array) => void;
      onClose: (reason: string, code?: number) => void;
    },
  ) => {
    const ws = new WebSocket(new URL('/stream', page.__bridge).href.replace(/^http/u, 'ws'));
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      mark('socket open');
      listeners.onOpen?.();
    };
    ws.onmessage = event =>
      listeners.onFrame(typeof event.data === 'string' ? event.data : new Uint8Array(event.data as ArrayBuffer));
    ws.onclose = event => listeners.onClose(event.reason, event.code);
    return {
      send: (frame: string | Uint8Array) => ws.send(frame as string | ArrayBuffer),
      close: (code?: number, reason?: string) => ws.close(code, reason),
    };
  },
};

const store = createVoiceModeStore();
store.subscribe(() => mark(`voice mode ${store.get('real-ferret').active ? 'on' : 'off'}`));

let lastWords = '';
let lastOutcome = '';
const observer = new MutationObserver(() => {
  const words = document.querySelector('[data-voice-mode-words]');
  const text = words?.textContent ?? '';
  const final = words?.getAttribute('data-final') === 'true';
  const key = `${final}:${text}`;
  if (text !== '' && key !== lastWords) {
    lastWords = key;
    mark(`words ${final ? 'final' : 'interim'}: ${text}`);
  }
  const outcome = document.querySelector('[data-voice-mode-outcome]')?.textContent ?? '';
  if (outcome !== '' && outcome !== lastOutcome) {
    lastOutcome = outcome;
    mark(`outcome: ${outcome}`);
  }
});
observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <main style={{ padding: 16 }}>
      <VoiceModeSlot
        client={client as never}
        fallback={
          <div data-fake-composer="">
            <textarea aria-label="Message" defaultValue="half a thought" />
            <VoiceModeButton client={client as never} ferretId="real-ferret" store={store} />
          </div>
        }
        ferretId="real-ferret"
        store={store}
        turn={{ state: 'your-turn', live: true }}
      />
    </main>,
  );
