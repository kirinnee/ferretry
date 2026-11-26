/**
 * The page half of `voice-e2e.visual.test.ts`: the SHIPPED voice mode (`VoiceModeButton`, `VoiceModeSlot`, and the real
 * `AutoReadPanel` that `voiceSurfaces` builds, so the real live-line reader and end-of-turn reading run) in front of a
 * stand-in composer. Only the edges are fake:
 *
 *   - the ferret: `window.__e2e.agent` appends the rows the chat would show (a person's message, a tool call, a `<voice>` line)
 *     and flips whose turn it is; the test's script decides when;
 *   - the microphone: silent units, loud ones while `window.__loud` is set (the person talking);
 *   - the audio device: the real `createReplyPlayer` over a clock-driven stand-in for the browser's `AudioContext`, so the
 *     real scheduling (the 150 ms lead, the heard-position arithmetic) runs and nothing is ever played out loud;
 *   - the machine: a WebSocket to the test's bridge, which runs the daemon's real `VoiceStream`.
 *
 * Everything the test needs to read back (when each sound became audible, each frame the page sent) is in `window.__e2e`,
 * stamped with this page's own `performance.now()`. Bundled by the test; never part of the app.
 */
import type { ConversationRowEntry } from '@ferretry/plugin-conversation/contract';
import { useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { decodeLineFrame, SPEAK_FRAME_BYTES } from '../../../../contract/index.ts';
import { VoiceModeButton } from '../../../../app/components/voice-mode-button.tsx';
import { VoiceModeSlot } from '../../../../app/components/voice-mode-panel.tsx';
import { ReadAloudProvider } from '../../../../app/hooks/use-read-aloud.ts';
import { createReplyPlayer, type PlayerContext } from '../../../../app/lib/stream/reply-player.ts';
import type { MicSource, ReplyPlayer } from '../../../../app/lib/stream/voice-stream.ts';
import { createReadAloud } from '../../../../app/lib/voice-chat/read-aloud.ts';
import { voiceSurfaces } from '../../../../app/surfaces.tsx';

const FERRET = 'e2e-ferret';
const page = globalThis as unknown as { __bridge: string; __loud?: boolean; __e2e: unknown };
document.documentElement.dataset.theme = 'studio-light';

// ─── what the test reads back ───────────────────────────────────────────────────────────────────────────────────────

/** A line the page handed to the machine, a drop, or a hush, at the page's own time. */
interface FrameLog {
  readonly at: number;
  readonly t: 'speak' | 'drop' | 'hush';
  readonly id?: number;
  readonly text?: string;
  readonly cut?: { readonly id: number; readonly samples: number } | null;
}
interface Played {
  readonly id: number;
  readonly samples: number;
  readonly at: number;
}
interface Audible {
  readonly id: number;
  /** When the first of this chunk of sound is heard (the page's `performance.now()` scale). */
  readonly atMs: number;
  readonly samples: number;
}

const frames: FrameLog[] = [];
const played: Played[] = [];
const audible: Audible[] = [];
const marks: Record<string, number> = {};
const positions: { at: number; id: number; samples: number }[] = [];
const stops: number[] = [];
const starts: unknown[] = [];

// ─── the ferret: rows and whose turn it is ───────────────────────────────────────────────────────────────────────────

let rows: readonly ConversationRowEntry[] = [];
let turn: { state: 'working' | 'your-turn'; at: string; live: boolean } = {
  state: 'your-turn',
  at: new Date().toISOString(),
  live: true,
};
const listeners = new Set<() => void>();
const changed = (): void => {
  for (const listener of listeners) listener();
};
let counter = 0;
const row = (kind: ConversationRowEntry['kind'], text: string): ConversationRowEntry => {
  counter += 1;
  return { id: `r${counter}`, kind, text, at: Date.now() };
};

const agent = {
  /** The person's message appears and the ferret starts working. */
  user(text: string): void {
    rows = [...rows, row('user', text)];
    turn = { state: 'working', at: new Date().toISOString(), live: true };
    changed();
  },
  tool(): void {
    rows = [...rows, row('tool', 'ran a command')];
    changed();
  },
  /** An assistant row (its `<voice>` lines are the ferret's own markdown), stamped under `label` when it reached the chat. */
  say(markdown: string, label: string): void {
    marks[label] = performance.now();
    rows = [...rows, row('assistant', markdown)];
    changed();
  },
  done(label: string): void {
    marks[label] = performance.now();
    turn = { state: 'your-turn', at: new Date().toISOString(), live: true };
    changed();
  },
};

// ─── the audio device ───────────────────────────────────────────────────────────────────────────────────────────────

const origin = performance.now();
let currentLine = -1;
/** When the last scheduled sound ends (the page's clock): the device is idle after it, or after a stop. */
let endsAt = 0;
const audio: PlayerContext = {
  get currentTime() {
    return (performance.now() - origin) / 1000;
  },
  outputLatency: 0,
  state: 'running',
  destination: {},
  resume: async () => undefined,
  close: async () => undefined,
  createBuffer: (_channels, length) => ({ copyToChannel: () => undefined, duration: length / 16_000, length }) as never,
  createBufferSource: () => {
    const source = {
      buffer: null as unknown,
      connect: () => undefined,
      start: (when: number) => {
        const samples = (source.buffer as { length: number }).length;
        audible.push({ id: currentLine, atMs: origin + when * 1000, samples });
        endsAt = Math.max(endsAt, origin + when * 1000 + (samples / 16_000) * 1000);
      },
      stop: () => undefined,
      onended: null as (() => void) | null,
    };
    return source;
  },
};

/** The real player, watched: which line each sound belongs to, where the person's ears were when it was asked, and every stop. */
const makePlayer = (): ReplyPlayer => {
  const real = createReplyPlayer(audio);
  return {
    play: (pcm, id) => {
      played.push({ id, samples: pcm.length, at: performance.now() });
      currentLine = id;
      real.play(pcm, id);
    },
    position: () => {
      const where = real.position();
      if (where !== undefined) positions.push({ at: performance.now(), ...where });
      return where;
    },
    stop: () => {
      stops.push(performance.now());
      endsAt = 0;
      real.stop();
    },
    remainingMs: () => real.remainingMs(),
    close: () => real.close(),
  };
};

// ─── the microphone: a quiet room, loud while the person talks ───────────────────────────────────────────────────────

const mic: MicSource = {
  start: async onUnit => {
    const begun = performance.now();
    let sent = 0;
    const timer = setInterval(() => {
      // Units are due 40 ms apart on the wall clock, so a late timer catches up instead of drifting.
      const due = Math.floor((performance.now() - begun) / 40);
      if (due - sent > 5) sent = due - 5;
      for (; sent < due; sent += 1) onUnit(new Int16Array(640).fill(page.__loud === true ? 7_000 : 0));
    }, 20);
    mic.stop = () => clearInterval(timer);
  },
  stop: () => undefined,
};

const createMic = (): MicSource => mic;

// ─── the machine ────────────────────────────────────────────────────────────────────────────────────────────────────

const view = {
  state: 'ready',
  machine: 'Test Box',
  label: 'Fake speech for the voice end-to-end test',
  sizeBytes: 1,
  doneBytes: 1,
  loaded: false,
};

const client = {
  call: async (route: string) => {
    if (route === 'POST /v1/voice/entry') return { sent: true };
    return view;
  },
  socket: (
    _route: string,
    _params: unknown,
    given: {
      onOpen?: () => void;
      onFrame: (frame: string | Uint8Array) => void;
      onClose: (reason: string, code?: number) => void;
    },
  ) => {
    const ws = new WebSocket(new URL('/stream', page.__bridge).href.replace(/^http/u, 'ws'));
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => given.onOpen?.();
    ws.onmessage = event =>
      given.onFrame(typeof event.data === 'string' ? event.data : new Uint8Array(event.data as ArrayBuffer));
    ws.onclose = event => given.onClose(event.reason, event.code);
    return {
      send: (frame: string | Uint8Array) => {
        if (typeof frame === 'string') {
          if (frame.length === SPEAK_FRAME_BYTES) {
            const line = decodeLineFrame(frame);
            const at = performance.now();
            if (line.t === 'speak') frames.push({ at, t: 'speak', id: line.id, text: line.text });
            else if (line.t === 'drop') frames.push({ at, t: 'drop', id: line.id });
            else frames.push({ at, t: 'hush', cut: line.cut ?? null });
          } else starts.push(JSON.parse(frame));
        }
        ws.send(frame as string | ArrayBuffer);
      },
      close: (code?: number, reason?: string) => ws.close(code, reason),
    };
  },
};

// ─── the page ───────────────────────────────────────────────────────────────────────────────────────────────────────

const surfaces = voiceSurfaces(client as never);
const { AutoReadPanel, voiceMode } = surfaces;

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

const snapshot = (): { rows: readonly ConversationRowEntry[]; turn: typeof turn } => ({ rows, turn });
let held = snapshot();
const read = (): typeof held => {
  if (held.rows !== rows || held.turn !== turn) held = snapshot();
  return held;
};

function Scene() {
  const now = useSyncExternalStore(
    notify => {
      listeners.add(notify);
      return () => listeners.delete(notify);
    },
    read,
    read,
  );
  return (
    <ReadAloudProvider controller={controller}>
      <main className="fy-vs" style={{ boxSizing: 'border-box', padding: 16 }}>
        <AutoReadPanel needsInput={{}} rows={now.rows} sends={[]} subject={FERRET} turn={now.turn} />
        <VoiceModeSlot
          client={client as never}
          createMic={createMic}
          createPlayer={makePlayer}
          fallback={
            <div data-fake-composer="">
              <textarea aria-label="Message" defaultValue="half a thought" />
              <VoiceModeButton client={client as never} createPlayer={makePlayer} ferretId={FERRET} store={voiceMode} />
            </div>
          }
          ferretId={FERRET}
          store={voiceMode}
          turn={now.turn}
        />
      </main>
    </ReadAloudProvider>
  );
}

/** Pretends the tab went to the background (or came back), the way the browser tells the page. */
const setHidden = (hidden: boolean): void => {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (hidden ? 'hidden' : 'visible'),
  });
  document.dispatchEvent(new Event('visibilitychange'));
};

page.__e2e = {
  agent,
  frames,
  played,
  audible,
  marks,
  positions,
  stops,
  starts,
  setHidden,
  now: () => performance.now(),
  idle: () => performance.now() >= endsAt,
};

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<Scene />);
