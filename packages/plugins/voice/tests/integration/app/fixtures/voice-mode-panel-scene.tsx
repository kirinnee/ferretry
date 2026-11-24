/**
 * Voice mode's panel (`VoiceModeSlot` and the Voice mode button) in front of a stand-in composer, over a fake machine.
 * `?theme=<family>-<mode>&talk=hearing|working|refused|notinstalled|speaking`. The stand-in composer is a text box holding the draft
 * "half a thought" and a Send button, so the page can prove the composer is hidden while voice mode is on and that the SAME
 * box (draft intact) is back after End. A fake microphone sends silent units (loud ones once `window.__loud` is set: the person
 * talking); nothing here records audio. `speaking`: `window.__read()` hands a reply to the page's read-aloud controller and the
 * fake machine answers each line it is sent with a quiet tone, at the speed it plays, until it is hushed.
 * `window.__fake` records what the machine was sent.
 */
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import {
  decodeLineFrame,
  encodeDownlinkUnit,
  encodeReplyDownlinkUnit,
  type StreamSnapshot,
} from '../../../../contract/index.ts';
import { ReadAloudProvider } from '../../../../app/hooks/use-read-aloud.ts';
import { createReadAloud } from '../../../../app/lib/voice-chat/read-aloud.ts';
import { VoiceModeButton } from '../../../../app/components/voice-mode-button.tsx';
import { VoiceModeSlot } from '../../../../app/components/voice-mode-panel.tsx';
import { createVoiceModeStore } from '../../../../app/lib/voice-mode/voice-mode-store.ts';
import type { MicSource } from '../../../../app/lib/stream/voice-stream.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const talk = params.get('talk') ?? 'hearing';

const fake = {
  starts: [] as string[],
  units: 0,
  closed: [] as unknown[],
  micStopped: 0,
  reads: 0,
  lines: [] as string[],
  hushes: 0,
};
(window as unknown as { __fake: typeof fake }).__fake = fake;
const flags = window as unknown as { __loud?: boolean; __read?: () => void; __reading?: () => string };

/** Whether the stream asked for the reply voice: its units are then the larger size. */
let replying = false;
const snapshot = (patch: Partial<StreamSnapshot>, pcm = new Int16Array(0)): Uint8Array => {
  const full: StreamSnapshot = { v: 1, state: 'listening', nonce: '0123456789abcdef', turn: 0, ...patch };
  return replying ? encodeReplyDownlinkUnit({ ...full, reply: 'ready' }, pcm) : encodeDownlinkUnit(full);
};
const words = (text: string, final: boolean) => ({
  turn: 1,
  rev: final ? 2 : 1,
  offset: 0,
  total: text.length,
  text,
  final,
});

const mic: MicSource = {
  start: async onUnit => {
    const timer = setInterval(() => {
      fake.units += 1;
      onUnit(new Int16Array(640).fill(flags.__loud === true ? 7_000 : 0));
    }, 40);
    mic.stop = () => {
      fake.micStopped += 1;
      clearInterval(timer);
    };
  },
  stop: () => undefined,
};

const view = {
  state: talk === 'notinstalled' ? 'not_installed' : 'ready',
  machine: 'Studio Mac',
  label: 'Parakeet TDT 0.6B v3 (int8) with Silero voice detection',
  sizeBytes: 698_905_830,
  doneBytes: talk === 'notinstalled' ? 0 : 698_905_830,
  loaded: false,
};

const client = {
  call: async () => {
    fake.reads += 1;
    return view;
  },
  socket: (
    _route: string,
    _params: unknown,
    listeners: {
      onOpen?: () => void;
      onFrame: (frame: Uint8Array) => void;
      onClose: (reason: string, code?: number) => void;
    },
  ) => {
    setTimeout(() => listeners.onOpen?.(), 0);
    const at = (ms: number, work: () => void) => setTimeout(work, ms);
    let tone: ReturnType<typeof setInterval> | undefined;
    return {
      send: (frame: string | Uint8Array) => {
        if (typeof frame !== 'string') return;
        if (fake.starts.length > 0) {
          // After the start record, a text frame is a line to speak or a hush.
          const line = decodeLineFrame(frame);
          if (line.t === 'hush') {
            fake.hushes += 1;
            if (tone !== undefined) clearInterval(tone);
            tone = undefined;
            return;
          }
          fake.lines.push(line.text);
          let sent = 0;
          tone = setInterval(() => {
            sent += 1;
            const pcm = Int16Array.from({ length: 3_200 }, (_, index) => Math.round(Math.sin(index / 9) * 1_500));
            listeners.onFrame(snapshot({ audio: { id: line.id, samples: pcm.length, last: sent >= 40 } }, pcm));
            if (sent >= 40 && tone !== undefined) clearInterval(tone);
          }, 200);
          return;
        }
        fake.starts.push(frame);
        replying = JSON.parse(frame).reply === 'machine';
        if (talk === 'refused') {
          at(100, () => {
            listeners.onFrame(
              snapshot({
                error: {
                  code: 'fleet_not_granted',
                  message: 'Voice chat needs permission to talk to ferrets on this machine as well.',
                },
              }),
            );
            listeners.onClose('voice chat needs the fleet permission as well', 4403);
          });
          return;
        }
        listeners.onFrame(snapshot({ state: 'loading' }));
        at(150, () => listeners.onFrame(snapshot({ state: 'listening' })));
        at(300, () =>
          listeners.onFrame(snapshot({ state: 'hearing', turn: 1, words: words('please check the build', false) })),
        );
        if (talk === 'hearing') return;
        at(900, () =>
          listeners.onFrame(
            snapshot({
              state: 'listening',
              turn: 1,
              words: words('Please check the build and tell me what failed.', true),
              last: { turn: 1, outcome: 'sent' },
            }),
          ),
        );
      },
      close: (code?: number, reason?: string) => {
        fake.closed.push([code, reason]);
      },
    };
  },
};

const store = createVoiceModeStore();
/** The device's own voice is silent here: the proof is the machine's. */
const controller = createReadAloud({
  speaker: {
    supported: true,
    voices: () => [{ id: 'd', name: 'Device', lang: 'en-US', local: true, isDefault: true }],
    unlock: () => undefined,
    speak: () => undefined,
    stop: () => undefined,
  },
  language: () => 'en-US',
});
flags.__read = () => controller.read('reply', '<voice>Let me check the build.</voice>');
flags.__reading = () => controller.getState().status;

function Scene() {
  const [draft, setDraft] = useState('half a thought');
  const working = talk === 'working';
  return (
    <ReadAloudProvider controller={controller}>
      <main
        className="fy-vs"
        style={{
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          minHeight: '100vh',
          padding: 16,
        }}
      >
        <div style={{ flex: 1 }}>
          <p>Ferret: I will look at the build.</p>
        </div>
        <div className="fy-chat-input">
          <VoiceModeSlot
            client={client as never}
            createMic={() => mic}
            fallback={
              <div data-fake-composer="" style={{ alignItems: 'center', display: 'flex', gap: 8 }}>
                <textarea
                  aria-label="Message"
                  onChange={event => setDraft(event.target.value)}
                  style={{ flex: 1, minHeight: 44 }}
                  value={draft}
                />
                <VoiceModeButton client={client as never} ferretId="ferret-1" store={store} />
                <button className="kt-btn" type="button">
                  Send
                </button>
              </div>
            }
            ferretId="ferret-1"
            store={store}
            turn={{ state: working ? 'working' : 'your-turn', live: true }}
          />
        </div>
      </main>
    </ReadAloudProvider>
  );
}

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<Scene />);
