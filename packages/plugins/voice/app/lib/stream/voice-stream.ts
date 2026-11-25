/**
 * The browser's end of the voice stream (`GET /v1/voice/stream`, unit 4): the microphone goes up in constant 40 ms
 * units, and the machine's snapshots come down every 200 ms. Everything the person sees (live words, what the machine is
 * doing, how the last turn ended) is read from those snapshots; nothing is guessed here.
 *
 * Audio leaves the page only through the shell's own socket (`PluginClient.socket`), so it is sealed end to end on
 * every carrier. It is never stored.
 */
import {
  DOWNLINK_UNIT_BYTES,
  REPLY_DOWNLINK_UNIT_BYTES,
  type ReplyState,
  STREAM_CLOSES,
  StreamProtocolError,
  type StreamControl,
  type StreamSnapshot,
  type StreamStart,
  UNIT_SAMPLES,
  UnitAssembler,
  WordsAssembler,
  decodeDownlinkUnit,
  decodeReplyDownlinkUnit,
  encodeHushFrame,
  encodeSpeakFrame,
  encodeUplinkUnit,
  fitSpeakText,
} from '../../../contract/index.ts';
import type { PluginClient } from '@ferretry/kernel/manifest';

export const VOICE_STREAM_ROUTE = 'GET /v1/voice/stream';

/** The microphone as 640-sample units, one every 40 ms for as long as it is open. */
export interface MicSource {
  /** Opens the microphone; each call of `onUnit` is exactly one 40 ms unit of 16 kHz PCM. Rejects if it is refused. */
  start(onUnit: (pcm: Int16Array) => void): Promise<void>;
  stop(): void;
}

/** The machine's sound for a reply line, played as it arrives: 16 kHz mono PCM, in order, with no gap the machine did not make. */
export interface ReplyPlayer {
  play(pcm: Int16Array): void;
  /** Silences everything queued at once. */
  stop(): void;
  /** How much sound is still waiting to be heard, in milliseconds. */
  remainingMs(): number;
  close(): void;
}

/** What happened to one line sent to the machine to be spoken. */
export interface SpeechLineEvent {
  readonly id: number;
  /** `started`: its first sound arrived. `finished`: all its sound has arrived. `failed`: the machine could not speak it (`code`). */
  readonly event: 'started' | 'finished' | 'failed';
  readonly code?: string;
  /** Only `started`: milliseconds from sending the line to its first sound arriving. */
  readonly firstSoundMs?: number;
}

export interface VoiceStreamEvents {
  /** Where the machine's reply voice is, whenever it changes. Only a stream that asked for it. */
  readonly onReply?: (state: ReplyState) => void;
  /** One line's progress. Only a stream that asked for the reply voice. */
  readonly onSpeech?: (line: SpeechLineEvent) => void;
  /** Every snapshot, as it arrives. */
  readonly onSnapshot: (snapshot: StreamSnapshot) => void;
  /** A whole revision of the turn's words, once its last fragment is in. */
  readonly onWords: (words: { readonly turn: number; readonly text: string; readonly final: boolean }) => void;
  /** The stream is over. `refusal` is the machine's own sentence when it said why; `code` the close code. */
  readonly onEnded: (ended: {
    readonly code: number | undefined;
    readonly reason: string;
    readonly sentence?: string;
  }) => void;
  /** The microphone could not be opened (permission, no device). */
  readonly onMicFailed: (cause: unknown) => void;
}

export interface VoiceStreamOptions {
  /** Where the machine's sound is played. Required for a stream that asked for the reply voice. */
  readonly player?: ReplyPlayer;
  /** Milliseconds, monotonic. A suite supplies its own. */
  readonly now?: () => number;
  /**
   * Told every unit of the microphone as it is SENT (zeros while muted), so barge-in hears exactly what the machine hears
   * and nothing a muted person said. It must not keep the unit: it is the same buffer the stream sends.
   */
  readonly onMicUnit?: (pcm: Int16Array) => void;
}

export interface VoiceStreamHandle {
  /**
   * Sends a reply line to the machine to be spoken, cut into pieces that each fit one frame. Each piece is a line of its
   * own with its own id, in order; the ids and their words are returned so the caller can read a failed one itself. A line
   * spoken before the stream has opened is held and sent right after the start record (a frame sent earlier is dropped).
   */
  speak(text: string): readonly { readonly id: number; readonly text: string }[];
  /**
   * Stops the reply voice at once (barge-in): the sound already queued here is silenced, the machine is told to drop the
   * lines it has not spoken, and the sound of every line sent so far is ignored if it still arrives.
   */
  hush(): void;
  /** Leaves on purpose: tells the machine, then closes. */
  stop(): void;
  setMuted(muted: boolean): void;
}

type SocketClient = Pick<PluginClient, 'socket'>;

/**
 * Opens the stream and starts the microphone once the machine has accepted it (a unit sent earlier would be dropped).
 * A downlink unit that does not parse ends the stream with a protocol error, as the machine does for the uplink.
 */
export function openVoiceStream(
  client: SocketClient,
  start: StreamStart,
  mic: MicSource,
  events: VoiceStreamEvents,
  options: VoiceStreamOptions = {},
): VoiceStreamHandle {
  if (client.socket === undefined) throw new Error('this browser has no way to open a voice stream');
  const wantsReply = start.reply === 'machine';
  if (wantsReply && options.player === undefined)
    throw new Error('a stream that asks for the reply voice needs a player');
  const now = options.now ?? (() => performance.now());
  const assembler = new UnitAssembler(wantsReply ? REPLY_DOWNLINK_UNIT_BYTES : DOWNLINK_UNIT_BYTES);
  const sentAt = new Map<number, number>();
  const began = new Set<number>();
  /** Sound of a line numbered below this is from before a hush and is never played. */
  let hushedBelow = 0;
  let nextLine = 0;
  /** Whether the start record has gone: a line spoken before then waits in `held`, since the transport drops it. */
  let opened = false;
  let held: { readonly id: number; readonly text: string }[] = [];
  let replyState: ReplyState | undefined;
  const words = new WordsAssembler();
  let echo: string | undefined;
  let control: StreamControl = 'none';
  let muted = false;
  let ended = false;
  let sentence: string | undefined;

  const hear = (audio: NonNullable<StreamSnapshot['audio']>, pcm: Int16Array | undefined): void => {
    if (audio.id < hushedBelow) return;
    if (pcm !== undefined && pcm.length > 0) {
      options.player?.play(pcm);
      if (!began.has(audio.id)) {
        began.add(audio.id);
        const at = sentAt.get(audio.id);
        events.onSpeech?.({
          id: audio.id,
          event: 'started',
          ...(at === undefined ? {} : { firstSoundMs: Math.round(now() - at) }),
        });
      }
    }
    if (audio.failed !== undefined) events.onSpeech?.({ id: audio.id, event: 'failed', code: audio.failed });
    else if (audio.last) events.onSpeech?.({ id: audio.id, event: 'finished' });
    if (audio.last) sentAt.delete(audio.id);
  };

  /** Sends one line to be spoken; its first sound is timed from now, when it really left. */
  const sendLine = (id: number, text: string): void => {
    sentAt.set(id, now());
    socket.send(encodeSpeakFrame({ t: 'speak', id, text }));
  };

  const finish = (code: number | undefined, reason: string): void => {
    if (ended) return;
    ended = true;
    options.player?.stop();
    mic.stop();
    events.onEnded({ code, reason, ...(sentence === undefined ? {} : { sentence }) });
  };

  const socket = client.socket(
    VOICE_STREAM_ROUTE,
    {},
    {
      onOpen: () => {
        socket.send(JSON.stringify(start));
        opened = true;
        const waiting = held;
        held = [];
        for (const line of waiting) sendLine(line.id, line.text);
        mic
          .start(pcm => {
            if (ended || pcm.length !== UNIT_SAMPLES) return;
            // Muted time is zero samples by contract: the microphone's audio never leaves the device while muted.
            const sending = muted ? new Int16Array(UNIT_SAMPLES) : pcm;
            socket.send(encodeUplinkUnit({ pcm: sending, control, echo }));
            options.onMicUnit?.(sending);
            // A control rides ONE unit; the next is plain audio again.
            if (control === 'unmuted' || control === 'muted') control = 'none';
          })
          .catch((cause: unknown) => {
            events.onMicFailed(cause);
            handle.stop();
          });
      },
      onFrame: frame => {
        if (typeof frame === 'string' || ended) return;
        try {
          for (const unit of assembler.push(frame)) {
            const decoded = wantsReply
              ? decodeReplyDownlinkUnit(unit)
              : { snapshot: decodeDownlinkUnit(unit), pcm: undefined };
            const snapshot = decoded.snapshot;
            echo = snapshot.nonce;
            if (snapshot.reply !== undefined && snapshot.reply !== replyState) {
              replyState = snapshot.reply;
              events.onReply?.(snapshot.reply);
            }
            if (snapshot.audio !== undefined) hear(snapshot.audio, decoded.pcm);
            if (snapshot.error !== undefined) sentence = snapshot.error.message;
            events.onSnapshot(snapshot);
            if (snapshot.words !== undefined) {
              const whole = words.accept(snapshot.words);
              if (whole !== undefined) events.onWords({ turn: whole.turn, text: whole.text, final: whole.final });
            }
          }
        } catch (error) {
          if (!(error instanceof StreamProtocolError)) throw error;
          socket.close(STREAM_CLOSES.protocol.code, STREAM_CLOSES.protocol.reason);
          finish(STREAM_CLOSES.protocol.code, STREAM_CLOSES.protocol.reason);
        }
      },
      onClose: (reason, code) => finish(code, reason),
    },
  );

  const handle: VoiceStreamHandle = {
    speak: text => {
      if (!wantsReply || ended) return [];
      const lines: { id: number; text: string }[] = [];
      for (const piece of fitSpeakText(text)) {
        const id = nextLine;
        nextLine += 1;
        if (opened) sendLine(id, piece);
        else held.push({ id, text: piece });
        lines.push({ id, text: piece });
      }
      return lines;
    },
    hush: () => {
      if (ended) return;
      options.player?.stop();
      hushedBelow = nextLine;
      sentAt.clear();
      began.clear();
      // Lines still held never reached the machine: dropping them is the whole hush.
      held = [];
      if (wantsReply && opened) socket.send(encodeHushFrame());
    },
    stop: () => {
      if (ended) return;
      // The machine hears "end" in a unit of its own, then the close: it stops listening at once and frees its place.
      try {
        socket.send(encodeUplinkUnit({ pcm: new Int16Array(UNIT_SAMPLES), control: 'end', echo }));
      } catch {
        // The socket was already gone: closing is all that is left.
      }
      socket.close(STREAM_CLOSES.ended.code, STREAM_CLOSES.ended.reason);
      finish(STREAM_CLOSES.ended.code, STREAM_CLOSES.ended.reason);
    },
    setMuted: next => {
      muted = next;
      control = next ? 'muted' : 'unmuted';
    },
  };
  return handle;
}
