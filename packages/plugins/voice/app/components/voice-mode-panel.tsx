/**
 * VOICE MODE: hands-free chat with a ferret, on the person's own machine.
 *
 * This file is the two halves of what stands in front of the composer (Conversation's `conversation.composer` slot):
 *
 *   - {@link VoiceModeSlot} is mounted for the whole chat. Off, it draws the composer exactly as it was. On, it keeps the
 *     composer MOUNTED but hidden — never dropped — so the draft, the caret and any attachments are the very ones that
 *     come back on End; and it draws the panel in the composer's place.
 *   - {@link VoiceModeSession} exists only while voice mode is on. It opens the voice stream (`purpose: 'chat'`) to the
 *     machine, shows what the machine hears and what it is doing, and lets the person mute or end. It never sends a
 *     message: the MACHINE does, once, right after the pause (the stream's own rules: a fresh nonce echo from this
 *     device first, `docs/voice.md` › The voice stream). A device that stops answering sends nothing.
 *
 * WHAT THE PERSON IS TOLD, IN WORDS. Loading, Listening, Hearing you, Working (the ferret's turn, read from the chat's
 * own live reading of the ferret, never guessed), Muted. A refused permission, a refused microphone or a browser that cannot
 * open a stream ends voice mode, gives the composer back and leaves one sentence above it; a machine that is LOST hands the
 * loop to the phone's own engine (`voice-mode-phone.tsx`, drawn by the page through `renderPhone`) with a banner that says why.
 *
 * THE REPLY IS SPOKEN BY THE MACHINE, ELSE BY THIS DEVICE. While the panel is on, the page's read-aloud controller speaks
 * through the machine's reply voice (Kokoro, over this same stream; {@link createMachineSpeaker}), and falls back to the
 * device's own voice when the machine has none or could not begin. Which replies are read, and when, is Auto-read's own rule
 * (`forced` while voice mode is on): the reading it starts is the one heard here.
 *
 * BARGE-IN. The microphone stays open while the MACHINE's voice speaks (echo cancellation is on in the browser's own
 * capture). Talking over it, for `BARGE_IN_MS` (300 ms), stops the sound at once and tells the machine to drop the rest; the
 * machine hears the same words and sends them after the pause as usual, so the person just carries on talking.
 *
 * THE MICROPHONE IS MUTED WHILE THE DEVICE'S OWN VOICE READS. A speech-synthesis voice is not part of the page's audio
 * graph, so nothing proves the browser can take it out of the microphone, and an open microphone under it would send the
 * reply back as the person's own words. Muted is zero samples on the wire (the stream's contract), not a flag the machine
 * is trusted to honour.
 */
import { Mic, MicOff, Square } from 'lucide-react';
import './voice-mode.css';
import { type ReactNode, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ConversationComposerProps } from '@ferretry/plugin-conversation/contract';
import type { ReplyState, StreamSnapshot, StreamState } from '../../contract/index.ts';
import { useReadAloudController } from '../hooks/use-read-aloud.ts';
import { browserMic } from '../lib/stream/mic-source.ts';
import { createReplyPlayer } from '../lib/stream/reply-player.ts';
import {
  type MicSource,
  openVoiceStream,
  type ReplyPlayer,
  type VoiceStreamHandle,
} from '../lib/stream/voice-stream.ts';
import { createBargeInDetector } from '../lib/voice-mode/barge-in.ts';
import { createMachineSpeaker } from '../lib/voice-mode/machine-speaker.ts';
import { lostBanner, shouldFallBack } from '../lib/voice-mode/phone-loop.ts';
import { useVoiceMode, type VoiceModeStore } from '../lib/voice-mode/voice-mode-store.ts';
import { Button, type VoicePluginClient } from '../shell-voice.ts';

type Turn = ConversationComposerProps['turn'];

/** What each machine state says. `working` here is the MACHINE turning the pause into words, not the ferret. */
const STATE_SENTENCE: Record<StreamState, (machine: string) => string> = {
  loading: machine => `Loading speech on ${machine}…`,
  listening: () => 'Listening. Just talk.',
  hearing: () => 'Hearing you…',
  working: machine => `${machine} is turning that into words…`,
  muted: () => 'Muted. Nothing you say leaves this device.',
};

const OUTCOME_SENTENCE: Record<string, string> = {
  sent: 'Sent.',
  heard: 'Heard.',
  dropped: 'No words that time.',
  failed: 'The machine could not turn that into words. Try again.',
  cancelled: 'The machine did not hear back from this device, so nothing was sent.',
};

/** A close the machine gave without a sentence of its own (the upgrade was refused, or the stream dropped). */
function refusalSentence(code: number, machine: string): string {
  if (code === 4408) return `${machine} stopped hearing this device, so voice mode ended.`;
  if (code === 4429) return `${machine} is already serving voice chats.`;
  if (code === 4450) return `${machine} could not keep up, so voice mode ended.`;
  if (code === 4401) return 'This device may no longer use voice on this machine.';
  if (code === 4403) return 'Voice mode also needs permission to talk to ferrets on this machine.';
  return `Lost ${machine} (closed ${code}). Voice mode ended.`;
}

interface Heard {
  readonly text: string;
  readonly final: boolean;
}

export interface VoiceModeSlotProps {
  readonly ferretId: string;
  readonly store: VoiceModeStore;
  readonly client: Pick<VoicePluginClient, 'socket'>;
  readonly turn: Turn | undefined;
  /** The composer, already drawn by the chat. */
  readonly fallback: ReactNode;
  /** A suite supplies a microphone; the page uses the browser's. */
  readonly createMic?: () => MicSource;
  /** A suite supplies a sound output for the machine's voice; the page uses the one its button made inside the tap. */
  readonly createPlayer?: () => ReplyPlayer;
  /**
   * The panel's phone-engine half (the fallback): the page's own draws it inside the voice stores it needs. Without one, a
   * machine that is lost ends voice mode as it always did.
   */
  readonly renderPhone?: (props: PhoneSlotProps) => ReactNode;
}

/** What the page's phone-engine panel is handed. */
export interface PhoneSlotProps {
  readonly ferretId: string;
  readonly machine: string;
  readonly banner: string;
  readonly store: VoiceModeStore;
  readonly turn: Turn | undefined;
}

export function VoiceModeSlot({
  ferretId,
  store,
  client,
  turn,
  fallback,
  createMic = browserMic,
  createPlayer = createReplyPlayer,
  renderPhone,
}: VoiceModeSlotProps) {
  const state = useVoiceMode(store, ferretId);
  // Leaving the chat (or a question taking the composer's place) ends voice mode: it never resumes by itself on return.
  useEffect(() => () => store.end(ferretId), [store, ferretId]);
  return (
    <>
      {state.notice === null ? null : (
        <p className="fy-voice-mode-notice" data-voice-mode-notice="" role="alert">
          <span>{state.notice}</span>
          <button className="kt-btn kt-btn--sm" onClick={() => store.dismiss(ferretId)} type="button">
            Dismiss
          </button>
        </p>
      )}
      {state.active && state.engine === 'phone' && renderPhone !== undefined ? (
        renderPhone({ ferretId, machine: state.machine, banner: state.banner ?? '', store, turn })
      ) : state.active ? (
        <VoiceModeSession
          canFallBack={renderPhone !== undefined}
          client={client}
          createMic={createMic}
          createPlayer={createPlayer}
          ferretId={ferretId}
          machine={state.machine}
          player={state.player}
          store={store}
          turn={turn}
        />
      ) : null}
      {/* Always the same place in the tree, so the composer is never remounted: only hidden while voice mode is on. */}
      <div
        data-voice-mode-composer={state.active ? 'hidden' : 'shown'}
        style={{ display: state.active ? 'none' : 'contents' }}
      >
        {fallback}
      </div>
    </>
  );
}

interface SessionProps {
  readonly ferretId: string;
  readonly machine: string;
  readonly store: VoiceModeStore;
  readonly client: Pick<VoicePluginClient, 'socket'>;
  readonly createMic: () => MicSource;
  readonly createPlayer: () => ReplyPlayer;
  /** The sound output the button made inside the tap, when it could. */
  readonly player: ReplyPlayer | undefined;
  readonly turn: Turn | undefined;
  /** Whether a lost machine hands the loop to the phone's own engine (the page supplies one). */
  readonly canFallBack: boolean;
}

function VoiceModeSession({
  ferretId,
  machine,
  store,
  client,
  createMic,
  createPlayer,
  player: given,
  turn,
  canFallBack,
}: SessionProps) {
  const [state, setState] = useState<StreamState>('loading');
  const [heard, setHeard] = useState<Heard | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [userMuted, setUserMuted] = useState(false);
  const handle = useRef<VoiceStreamHandle | null>(null);
  const applied = useRef(false);

  const reader = useReadAloudController();
  const isReading = (): boolean => reader.getState().status === 'reading';
  const reading = useSyncExternalStore(reader.subscribe, isReading, isReading);
  /** The machine's voice is the one reading (not the device's): only then is the microphone left open under it. */
  const [machineVoice, setMachineVoice] = useState(false);
  const [interrupted, setInterrupted] = useState(false);
  const muted = userMuted || (reading && !machineVoice);
  const live = useRef({ reading, machineVoice });
  live.current = { reading, machineVoice };

  // The sound output: the one made inside the tap, else one now (a browser without audio has none, and the device reads).
  const [player] = useState<ReplyPlayer | undefined>(() => {
    if (given !== undefined) return given;
    try {
      return createPlayer();
    } catch {
      return undefined;
    }
  });
  useEffect(() => () => player?.close(), [player]);
  const replyState = useRef<ReplyState | undefined>(undefined);

  useEffect(() => {
    if (client.socket === undefined) {
      store.end(ferretId, 'This browser cannot open a voice stream to the machine.');
      return undefined;
    }
    let disposed = false;
    let turnNumber = 0;
    const detector = createBargeInDetector();
    const speaker =
      player === undefined
        ? undefined
        : createMachineSpeaker({
            stream: () => handle.current ?? undefined,
            replyState: () => replyState.current,
            player,
            onActive: active => {
              if (!disposed) setMachineVoice(active);
            },
          });
    if (speaker !== undefined) reader.attach(speaker);
    const opened = openVoiceStream(
      client,
      { t: 'start', v: 1, purpose: 'chat', ferretId, ...(player === undefined ? {} : { reply: 'machine' as const }) },
      createMic(),
      {
        onReply: state => {
          replyState.current = state;
        },
        onSpeech: line => speaker?.onSpeech(line),
        onSnapshot: (snapshot: StreamSnapshot) => {
          if (disposed) return;
          setState(snapshot.state);
          if (snapshot.turn !== turnNumber) {
            turnNumber = snapshot.turn;
            setHeard(null);
          }
          if (snapshot.last !== undefined) setOutcome(OUTCOME_SENTENCE[snapshot.last.outcome] ?? null);
        },
        onWords: words => {
          if (!disposed) setHeard({ text: words.text, final: words.final });
        },
        onEnded: ended => {
          if (disposed) return;
          handle.current = null;
          // A machine that could not keep going hands the loop to this phone's own engine, and says so; a person's End or a
          // refused permission is not a failure to route round.
          if (canFallBack && shouldFallBack(ended))
            store.fallBack(ferretId, lostBanner(machine, ended.code, ended.sentence));
          else if (ended.sentence !== undefined) store.end(ferretId, ended.sentence);
          else if (ended.code !== 1000 && ended.code !== undefined)
            store.end(ferretId, refusalSentence(ended.code, machine));
          else store.end(ferretId);
        },
        onMicFailed: () => {
          if (!disposed)
            store.end(ferretId, 'The microphone could not be opened. Allow it for this site and try again.');
        },
      },
      {
        ...(player === undefined ? {} : { player }),
        // Talking over the machine's voice stops it; the device's own voice is never talked over (the microphone is muted).
        onMicUnit: pcm => {
          const { reading: on, machineVoice: machineOn } = live.current;
          const armed = on && machineOn;
          if (!detector.push(pcm, armed)) return;
          reader.stop();
          setInterrupted(true);
        },
      },
    );
    handle.current = opened;
    return () => {
      disposed = true;
      handle.current = null;
      if (speaker !== undefined) reader.attach(null);
      setMachineVoice(false);
      opened.stop();
    };
  }, [canFallBack, client, createMic, ferretId, machine, player, reader, store]);

  // A new reading starts a clean slate for the "stopped" note.
  useEffect(() => {
    if (reading) setInterrupted(false);
  }, [reading]);

  // The machine is told once per change; the first unit of a stream starts unmuted.
  useEffect(() => {
    if (applied.current === muted) return;
    applied.current = muted;
    handle.current?.setMuted(muted);
  }, [muted]);

  const end = useCallback(() => store.end(ferretId), [store, ferretId]);
  const working = turn?.live === true && turn.state === 'working' && !muted;
  const shown: StreamState = muted ? 'muted' : state;
  const status = reading
    ? machineVoice
      ? 'Speaking. Talk any time to interrupt.'
      : 'Reading the reply. Your microphone is off until it is done.'
    : interrupted
      ? 'Stopped. Go ahead, I am listening.'
      : working && (state === 'listening' || state === 'hearing')
        ? 'Working… you can keep talking.'
        : STATE_SENTENCE[shown](machine);

  return (
    <section
      aria-label="Voice mode"
      className="fy-voice-mode"
      data-engine="machine"
      data-reply-voice={reading ? (machineVoice ? 'machine' : 'device') : 'none'}
      data-state={reading && !machineVoice ? 'muted' : working ? 'working' : shown}
      data-voice-mode="on"
    >
      <p aria-live="polite" className="fy-voice-mode__status" data-voice-mode-status="" role="status">
        <span aria-hidden="true" className="fy-voice-mode__dot" />
        {status}
      </p>
      <p
        aria-live="polite"
        className="fy-voice-mode__words"
        data-final={heard === null ? 'none' : String(heard.final)}
        data-voice-mode-words=""
      >
        {heard?.text ?? ''}
      </p>
      {outcome === null ? null : (
        <p className="fy-voice-mode__note" data-voice-mode-outcome="">
          {outcome}
        </p>
      )}
      <div className="fy-voice-mode__actions">
        <Button
          aria-pressed={userMuted}
          data-voice-mode-mute=""
          onClick={() => setUserMuted(value => !value)}
          type="button"
        >
          {userMuted ? <MicOff aria-hidden="true" size={16} /> : <Mic aria-hidden="true" size={16} />}
          {userMuted ? 'Unmute' : 'Mute'}
        </Button>
        <Button data-voice-mode-end="" onClick={end} type="button" variant="primary">
          <Square aria-hidden="true" size={16} /> End voice mode
        </Button>
      </div>
    </section>
  );
}
