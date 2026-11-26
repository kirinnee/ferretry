import type { Clock, SocketDownstream, SocketEnded, SocketFrame, SocketHandler } from '@ferretry/kernel/contract';
import { milliseconds } from '@ferretry/std';
import {
  DOWNLINK_JSON_MAX_BYTES,
  PAUSE_STYLES,
  PROOF_WINDOW_MS,
  REPLY_AUDIO_SAMPLES,
  SILENT_PHONE_MS,
  SPEAK_QUEUE_MAX,
  STREAM_CLOSES,
  STREAM_MAX_MS,
  StreamProtocolError,
  type ReplyAudio,
  type ReplyState,
  type ReplySpeakerApi,
  type StreamSnapshot,
  type StreamStart,
  StreamStartSchema,
  type StreamState,
  TICK_MS,
  TURN_MAX_MS,
  type TurnOutcome,
  UNIT_MS,
  UPLINK_UNIT_BYTES,
  UnitAssembler,
  ENTRY_RENEW_MS,
  VOICE_ENTRY_MESSAGE,
  WORDS_MAX_CHARS,
  type VoiceEngineApi,
  VoiceEngineError,
  decodeLineFrame,
  decodeUplinkUnit,
  encodeDownlinkUnit,
  encodeReplyDownlinkUnit,
  entrySendId,
  snapshotBytes,
} from '../../../contract/index.ts';
import { splitForSpeech } from '../reply/chunks.ts';
import { SampleBuffer, SECOND } from './samples.ts';

/** Sentences a person reads, one per refusal code. None carries a transcript. */
const SENTENCES: Readonly<Record<string, string>> = {
  engine_behind: 'This machine is too busy to keep up, so that turn was lost. Say it again.',
  engine_timeout: 'This machine took too long to turn that into words, so that turn was lost. Say it again.',
  engine_overloaded: 'This machine is overloaded: three turns in a row were lost.',
  voice_no_memory: 'This machine does not have enough free memory to load speech right now.',
  voice_not_ready: 'Speech is not installed on this machine yet.',
  voice_busy: 'Another voice chat already holds this ferret.',
  voice_unavailable: 'Voice chat cannot send messages on this machine right now.',
  engine_failed: 'Speech could not start on this machine.',
  send_refused: 'The machine could not hand that message to the ferret.',
  phone_silent: 'The device stopped answering, so that message was not sent.',
  no_words: 'No words were heard.',
  fleet_not_granted:
    'This device may not use the agent fleet, so voice chat cannot send to a ferret. Voice chat needs both the voice and the fleet permissions.',
  ferret_unknown: 'No single ferret goes by that name on this machine.',
};
/** Why one line was not spoken by the machine, so the device reads it instead. These are codes, not sentences: the browser decides what to say. */
const LINE_ABSENT = 'reply_voice_absent';
const LINE_FAILED = 'reply_voice_failed';
const LINE_QUEUE_FULL = 'queue_full';
/** The close each refusal ends the stream with; any other refusal is a failure on the machine. */
const CLOSE_FOR: Readonly<Record<string, { readonly code: number; readonly reason: string }>> = {
  engine_overloaded: STREAM_CLOSES.overloaded,
  voice_busy: STREAM_CLOSES.busy,
  fleet_not_granted: STREAM_CLOSES.forbidden,
};
const sentenceOf = (code: string): string => SENTENCES[code] ?? 'Something went wrong on the machine.';

/** What the stream needs from the rest of the daemon. Everything outside the audio is a port, so each is faked in tests. */
export interface StreamParts {
  /** The engine's PUBLIC API only: it loads on first use and unloads itself when idle. */
  readonly engine: Pick<VoiceEngineApi, 'transcribe' | 'detectSpeech'>;
  readonly clock: Pick<Clock, 'nowMs' | 'every' | 'after'>;
  readonly downstream: SocketDownstream;
  /** Names this stream inside every send id (`<streamId>:<turn>`). */
  readonly streamId: string;
  /** 16 lowercase hex characters, unguessable. */
  readonly nonce: () => string;
  /** `undefined` when Conversation is not loaded: a chat stream is then refused. */
  readonly send:
    | ((
        ferretId: string,
        message: string,
        sendId: string,
      ) => Promise<{ readonly ok: true } | { readonly ok: false; readonly code: string }>)
    | undefined;
  /**
   * Whether this caller may use the agent fleet RIGHT NOW (`fleet.use`, the grant a typed send needs). Voice chat sends to
   * a ferret, so it needs this as well as `voice.use`; asked at the start and again before every send.
   */
  readonly mayChat: () => boolean;
  /** The ferret a name or an id means (the same rule a typed send's path uses); `undefined` when none or several do. */
  readonly resolveFerret: (reference: string) => Promise<string | undefined>;
  /** Writes the audit record a typed send leaves, once per message handed over. */
  readonly recordSent: (ferretId: string) => void;
  /** Takes the one voice chat a ferret may have; `undefined` when another stream holds it. Returns the release. */
  readonly claimFerret: (ferretId: string) => (() => void) | undefined;
  /**
   * The chat's entry claim, shared by every stream and phone engine of this machine (the registry holds it). `enter` is true
   * only for the call that finds no live claim: that one sends the entry message. Absent (a suite): every entry sends.
   */
  readonly entry?: {
    readonly enter: (ferretId: string) => boolean;
    readonly leave: (ferretId: string) => void;
  };
  /**
   * The machine's reply voice. `undefined` only where there is none to ask (a suite): a stream that asks for it is then told
   * `absent`. A stream that does not ask for it never touches this.
   */
  readonly reply?: ReplySpeakerApi | undefined;
  /** Called once when the stream is over, whatever ended it. */
  readonly onEnd: () => void;
  readonly log: { info(message: string, fields?: Record<string, string | number | boolean>): void };
}

/** Speech that is shorter than this is not a turn (the engine's own spans already drop anything under 256 ms). */
const LEAD_IN = Math.round(0.3 * SECOND);
/** Audio the engine may owe a stream before it must say "too busy" (design §3.1). */
const BEHIND = 2 * SECOND;
/** Interim words are re-decoded this often, and only while the turn is short enough to decode in about two seconds (5 s → 1.76 s). */
const INTERIM_EVERY = Math.round(1.2 * SECOND);
const INTERIM_MAX = 5 * SECOND;
/**
 * The final decode starts this long after the last word, not at the pause: if the voice has not come back by the pause
 * the turn is already decoded and only the proof of the phone is left to wait for. A decode that voice then outdates is
 * thrown away. Only turns short enough to interim-decode start early (a longer decode would leave audio unseen).
 */
const EARLY_SILENCE = Math.round(0.3 * SECOND);
/** Audio that arrives while no turn is open is kept this long, so a late speech start is not clipped. */
const IDLE_KEEP = Math.round(1.5 * SECOND);
/** The most unheard audio kept while a turn is being finished. */
const BACKLOG_KEEP = 5 * SECOND;
const FINAL_BASE_MS = 5_000;
const NO_START_MS = 5_000;
/** Units allowed in any 5 s: the nominal 125, with a quarter of headroom (design §3.1). */
const RATE_WINDOW_MS = 5_000;
const RATE_LIMIT = Math.floor((RATE_WINDOW_MS / UNIT_MS) * 1.25);
const OVERLOAD_AFTER = 3;
const ISSUED_KEPT = 32;
/** The most audio ever held: a whole turn plus the backlog; a stuck engine call cannot grow it further. */
const SAMPLES_CAP = Math.round((TURN_MAX_MS / 1000) * SECOND) + BACKLOG_KEEP;
/** A backed-up socket (the browser stopped reading) ends the stream rather than growing without bound. */
const MAX_BUFFERED = 64 * 1024;

/** The most sound waiting to be sent down: more than this and the next line is not made until some has gone. */
const OUTGOING_MAX = 30 * SECOND;

type Phase = 'loading' | 'idle' | 'hearing' | 'working';

/** Sound made for one line, waiting for its place in the downlink. An empty one is a line's end or its failure. */
interface Outgoing {
  readonly id: number;
  readonly pcm: Int16Array;
  offset: number;
  readonly last: boolean;
  readonly failed?: string;
}

const toPcm16 = (samples: Float32Array): Int16Array => {
  const out = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1)
    out[index] = Math.max(-32768, Math.min(32767, Math.round((samples[index] ?? 0) * 32767)));
  return out;
};

/**
 * One open voice stream: the uplink's audio in, the downlink's snapshots out, and the one decision the machine makes on
 * its own, which is when a turn ends and whether to send it.
 *
 * WHY IT IS SAFE TO SEND WITHOUT ASKING (owner decision O1: no countdown): a turn is sent only after an echo of a nonce
 * the machine issued AFTER it heard the pause. A phone that died, lost its network or went into a tunnel cannot echo it,
 * so the turn is cancelled and nothing is sent. The kernel re-checks the device's `voice.use` on every uplink frame and
 * closes the stream the moment it is narrowed, so a device that lost the grant never reaches the send either.
 */
export class VoiceStream implements SocketHandler {
  private readonly assembler = new UnitAssembler(UPLINK_UNIT_BYTES);
  private readonly samples = new SampleBuffer();
  private readonly cancels: (() => void)[] = [];
  private readonly issued = new Map<string, number>();
  private readonly arrivals: number[] = [];
  private readonly sentTurns = new Set<number>();

  private start: StreamStart | undefined;
  private releaseFerret: (() => void) | undefined;
  private ferretId: string | undefined;
  private phase: Phase = 'loading';
  private muted = false;
  private ended = false;
  private stepping = false;
  private fatal: { code: string; message: string } | undefined;
  private openedAt = 0;
  private lastUnitAt = 0;

  private emitSeq = 0;
  private echoSeq = -1;
  private wakeProof: (() => void) | undefined;

  private turn = 0;
  private turnStart = 0;
  private lastSpeechEnd = 0;
  private seenLength = 0;
  private interimAt = 0;
  /** The decode of this turn that began in the pause, valid only while no voice has come back (same `cut`). */
  private early: { turn: number; cut: number; text: string } | undefined;
  /** Where the audio the VAD has not looked at starts, after an early decode kept it from looking: it is scanned from here. */
  private scanFrom: number | undefined;
  /** Speculative decodes (interim words, the early decode) wait until the engine has been left alone as long as it was kept busy. */
  private speculateAfter = 0;
  private pauseSamples = 0;
  private words: { turn: number; rev: number; text: string; offset: number; final: boolean } | undefined;
  private last: TurnOutcome | undefined;
  private failures = 0;

  private replyState: ReplyState | undefined;
  private readonly spokenQueue: { id: number; text: string }[] = [];
  private readonly outgoing: Outgoing[] = [];
  private outgoingSamples = 0;
  private draining = false;
  /** Bumped by every hush: a line being made when it changed is thrown away, never queued. */
  private hushes = 0;
  /** Lines the device took back before any of their sound went down: the one being made is thrown away when it finishes. */
  private readonly dropped = new Set<number>();
  /** Lines whose first sound has gone down the stream (so a drop is too late); forgotten when the line ends. */
  private readonly sounding = new Set<number>();
  /** The line being made right now. */
  private making: number | undefined;

  constructor(private readonly parts: StreamParts) {}

  async open(): Promise<void> {
    const now = this.parts.clock.nowMs();
    this.openedAt = now;
    this.lastUnitAt = now;
    this.cancels.push(this.parts.clock.every(milliseconds(TICK_MS), () => this.tick()));
    this.cancels.push(this.parts.clock.after(milliseconds(STREAM_MAX_MS), () => this.endWith(STREAM_CLOSES.ended)));
    // Nothing is sent until the start record has arrived: what it asks for decides the size of every unit after it (a
    // stream that asked for the reply voice has a larger one), so a unit sent first could be the wrong size.
  }

  fromClient(frame: SocketFrame): void {
    if (this.ended) return;
    try {
      if (typeof frame === 'string') this.onText(frame);
      else this.onBytes(frame);
    } catch (error) {
      if (error instanceof StreamProtocolError) this.endWith(STREAM_CLOSES.protocol);
      else throw error;
    }
  }

  close(_ended?: SocketEnded): void {
    this.finish();
  }

  // ─── uplink ────────────────────────────────────────────────────────────────────────────────────────────────────

  private onText(text: string): void {
    if (this.start !== undefined) {
      this.onSpeak(text);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new StreamProtocolError('the start record is not JSON');
    }
    const start = StreamStartSchema.safeParse(parsed);
    if (!start.success) throw new StreamProtocolError('the start record is not one the stream defines');
    this.start = start.data;
    this.pauseSamples = Math.round((PAUSE_STYLES[start.data.style ?? 'normal'] / 1000) * SECOND);
    if (start.data.reply === 'machine') this.beginReply();
    // The first snapshot a client reads: it carries the first nonce, and says what the machine is doing from here on.
    this.emit();
    if (start.data.purpose === 'chat') {
      if (this.parts.send === undefined) {
        this.refuse('voice_unavailable');
        return;
      }
      if (!this.parts.mayChat()) {
        this.refuse('fleet_not_granted');
        return;
      }
      void this.beginChat(start.data.ferretId, start.data.session);
      return;
    }
    this.begin(start.data.purpose);
  }

  /** A chat stream is for ONE ferret: its id (an id and its callsign are the same ferret) is the one claimed. */
  private async beginChat(reference: string, session: string | undefined): Promise<void> {
    let id: string | undefined;
    try {
      id = await this.parts.resolveFerret(reference);
    } catch {
      id = undefined;
    }
    if (this.ended) return;
    if (id === undefined) return this.refuse('ferret_unknown');
    this.releaseFerret = this.parts.claimFerret(id);
    if (this.releaseFerret === undefined) return this.refuse('voice_busy');
    this.ferretId = id;
    this.begin('chat');
    // A client that named no session is one that predates the entry message: it gets the stream it always had.
    if (session === undefined) return;
    this.cancels.push(this.parts.clock.every(milliseconds(ENTRY_RENEW_MS), () => void this.parts.entry?.enter(id)));
    if (this.parts.entry?.enter(id) !== false) void this.sendEntry(id, session);
  }

  /**
   * Voice mode was just entered: tell the ferret at once, in one message, so the grammar `instructions/voice.md` teaches is
   * switched on for this conversation. The chat's claim (the registry's) decides WHO sends it, so a second tab or a phone
   * engine on the same chat sends nothing; the send id belongs to the voice-mode SESSION (the device keeps it across
   * reconnects), so a stream that drops and reopens inside the claim's lease is not a second message. A refusal is not
   * fatal: the person can still talk, the typed instruction is in the ferret's static layer either way, and the claim is
   * given up so the next to enter sends it.
   */
  private async sendEntry(ferretId: string, session: string): Promise<void> {
    if (this.ended || this.parts.send === undefined || !this.parts.mayChat()) {
      this.parts.entry?.leave(ferretId);
      return;
    }
    let result: Awaited<ReturnType<NonNullable<StreamParts['send']>>>;
    try {
      result = await this.parts.send(ferretId, VOICE_ENTRY_MESSAGE, entrySendId(session));
    } catch {
      result = { ok: false, code: 'send_refused' };
    }
    if (!result.ok) {
      this.parts.entry?.leave(ferretId);
      this.parts.log.info('voice.stream.entry_refused', { stream: this.parts.streamId, code: result.code });
      return;
    }
    // Not audited: it is a fixed sentence of the machine's own, with none of the person's words, and a reconnect sends it again.
    this.parts.log.info('voice.stream.entered', { stream: this.parts.streamId });
  }

  private begin(purpose: string): void {
    this.parts.log.info('voice.stream.start', { purpose, stream: this.parts.streamId });
    void this.warmUp();
  }

  // ─── the reply voice ───────────────────────────────────────────────────────────────────────────────────────────

  /** A stream that asked for the machine's voice: learn whether there is one, and load it now so the first line is not what waits. */
  private beginReply(): void {
    const reply = this.parts.reply;
    if (reply === undefined) {
      this.replyState = 'absent';
      return;
    }
    this.replyState = 'loading';
    void (async () => {
      try {
        if ((await reply.view()).state !== 'ready') throw new Error('not installed');
        await reply.warm();
        if (this.ended) return;
        this.replyState = 'ready';
        void this.drain();
      } catch {
        if (this.ended) return;
        this.replyState = 'absent';
        this.failQueued(LINE_ABSENT);
      }
    })();
  }

  /** One line to speak. A device that did not ask for the voice has no business sending one: that is a protocol error. */
  private onSpeak(text: string): void {
    if (this.start?.reply !== 'machine') throw new StreamProtocolError('this stream did not ask for the reply voice');
    const frame = decodeLineFrame(text);
    if (frame.t === 'hush') {
      this.hush();
      return;
    }
    if (frame.t === 'drop') {
      this.drop(frame.id);
      return;
    }
    const refusal =
      this.replyState === 'absent'
        ? LINE_ABSENT
        : this.spokenQueue.length >= SPEAK_QUEUE_MAX
          ? LINE_QUEUE_FULL
          : undefined;
    if (refusal !== undefined) {
      this.queueSound({ id: frame.id, pcm: new Int16Array(0), offset: 0, last: true, failed: refusal });
      return;
    }
    this.spokenQueue.push({ id: frame.id, text: frame.text });
    void this.drain();
  }

  /**
   * The person talked over the reply (barge-in): every line not yet spoken, and every sound not yet sent, is dropped, and the
   * line being made is thrown away when it finishes. Nothing is reported back: the device has already stopped playing, and
   * ignores any sound of a line it sent before it hushed.
   */
  private hush(): void {
    this.hushes += 1;
    this.dropped.clear();
    this.sounding.clear();
    this.spokenQueue.length = 0;
    this.outgoing.length = 0;
    this.outgoingSamples = 0;
  }

  /**
   * One waiting line is no longer wanted (a newer progress line outdated it): it is taken out of the queue and any sound made
   * for it is not sent, and the line being made is thrown away when it finishes. A line whose first sound has gone down
   * is left alone: the person has heard its start. Nothing is reported back; the device forgot the line when it asked.
   */
  private drop(id: number): void {
    if (this.sounding.has(id)) return;
    this.dropped.add(id);
    const waiting = this.spokenQueue.findIndex(line => line.id === id);
    if (waiting !== -1) this.spokenQueue.splice(waiting, 1);
    for (let at = this.outgoing.length - 1; at >= 0; at -= 1) {
      const sound = this.outgoing[at];
      if (sound?.id !== id) continue;
      this.outgoingSamples -= sound.pcm.length - sound.offset;
      this.outgoing.splice(at, 1);
    }
    // Only the line being made still has to remember it was dropped; for any other there is nothing left to throw away.
    if (this.making !== id) this.dropped.delete(id);
  }

  private failQueued(code: string): void {
    for (const line of this.spokenQueue.splice(0))
      this.queueSound({ id: line.id, pcm: new Int16Array(0), offset: 0, last: true, failed: code });
  }

  private queueSound(sound: Outgoing): void {
    this.outgoing.push(sound);
    this.outgoingSamples += sound.pcm.length;
  }

  /** Lines are made one at a time, in the order they were sent, and no faster than the downlink can carry them away. */
  private async drain(): Promise<void> {
    if (this.draining || this.replyState !== 'ready') return;
    this.draining = true;
    try {
      for (;;) {
        if (this.ended) return;
        const next = this.spokenQueue[0];
        if (next === undefined) return;
        if (this.outgoingSamples > OUTGOING_MAX) {
          await new Promise<void>(resolve => this.parts.clock.after(milliseconds(TICK_MS), resolve));
          continue;
        }
        this.spokenQueue.shift();
        await this.speakLine(next.id, next.text);
      }
    } finally {
      this.draining = false;
    }
  }

  private async speakLine(id: number, text: string): Promise<void> {
    const reply = this.parts.reply;
    const hushes = this.hushes;
    const pieces = splitForSpeech(text);
    this.making = id;
    try {
      await this.speakPieces(reply, hushes, id, pieces);
    } finally {
      this.making = undefined;
      this.dropped.delete(id);
    }
  }

  private async speakPieces(
    reply: StreamParts['reply'],
    hushes: number,
    id: number,
    pieces: readonly string[],
  ): Promise<void> {
    if (reply === undefined || pieces.length === 0) {
      this.queueSound({
        id,
        pcm: new Int16Array(0),
        offset: 0,
        last: true,
        ...(reply === undefined ? { failed: LINE_ABSENT } : {}),
      });
      return;
    }
    for (const [index, piece] of pieces.entries()) {
      let made: Awaited<ReturnType<typeof reply.speak>>;
      try {
        made = await reply.speak(piece);
      } catch {
        if (!this.ended && hushes === this.hushes)
          this.queueSound({ id, pcm: new Int16Array(0), offset: 0, last: true, failed: LINE_FAILED });
        return;
      }
      if (this.ended || hushes !== this.hushes) return;
      if (this.dropped.has(id)) return;
      const pcm = toPcm16(made.samples);
      // Milliseconds and counts only: what was said never reaches a log.
      this.parts.log.info('voice.stream.spoke', {
        stream: this.parts.streamId,
        line: id,
        piece: index,
        speakMs: Math.round(made.speakMs),
        audioMs: Math.round((pcm.length / SECOND) * 1000),
      });
      this.queueSound({ id, pcm, offset: 0, last: index === pieces.length - 1 });
    }
  }

  /** The next 200 ms of sound for the downlink: one line's, from as many of its pieces as fill the slot. */
  private nextSound(): { readonly audio: ReplyAudio; readonly pcm: Int16Array } | undefined {
    const head = this.outgoing[0];
    if (head === undefined) return undefined;
    const pcm = new Int16Array(REPLY_AUDIO_SAMPLES);
    let filled = 0;
    let last = false;
    let failed: string | undefined;
    while (this.outgoing[0]?.id === head.id) {
      const piece = this.outgoing[0];
      if (piece === undefined) break;
      const take = Math.min(REPLY_AUDIO_SAMPLES - filled, piece.pcm.length - piece.offset);
      pcm.set(piece.pcm.subarray(piece.offset, piece.offset + take), filled);
      piece.offset += take;
      filled += take;
      this.outgoingSamples -= take;
      if (piece.offset < piece.pcm.length) break;
      this.outgoing.shift();
      if (piece.failed !== undefined) failed = piece.failed;
      if (piece.last) {
        last = true;
        break;
      }
    }
    if (filled > 0) this.sounding.add(head.id);
    if (last) {
      this.sounding.delete(head.id);
      this.dropped.delete(head.id);
    }
    return {
      audio: { id: head.id, samples: filled, last, ...(failed === undefined ? {} : { failed }) },
      pcm: pcm.subarray(0, filled),
    };
  }

  private onBytes(frame: Exclude<SocketFrame, string>): void {
    if (this.start === undefined) throw new StreamProtocolError('the start record comes first');
    const bytes =
      frame instanceof ArrayBuffer
        ? new Uint8Array(frame)
        : new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
    for (const unit of this.assembler.push(bytes)) {
      if (this.ended) return;
      this.onUnit(unit);
    }
  }

  private onUnit(bytes: Uint8Array): void {
    const now = this.parts.clock.nowMs();
    this.arrivals.push(now);
    while (this.arrivals.length > 0 && (this.arrivals[0] ?? now) <= now - RATE_WINDOW_MS) this.arrivals.shift();
    if (this.arrivals.length > RATE_LIMIT) {
      this.endWith(STREAM_CLOSES.tooFast);
      return;
    }
    this.lastUnitAt = now;
    const unit = decodeUplinkUnit(bytes);
    if (unit.echo !== undefined) {
      const seq = this.issued.get(unit.echo);
      if (seq !== undefined && seq > this.echoSeq) {
        this.echoSeq = seq;
        this.wakeProof?.();
      }
    }
    if (unit.control === 'end') {
      this.endWith(STREAM_CLOSES.ended);
      return;
    }
    if (unit.control === 'muted') this.muted = true;
    if (unit.control === 'unmuted') this.muted = false;
    // Muted time is zero samples by contract, so it is dropped here rather than listened to.
    // The buffer is capped, so a stuck engine call cannot grow memory without bound: the excess is dropped.
    if (!this.muted && unit.control !== 'muted') {
      const room = SAMPLES_CAP - this.samples.length;
      if (room >= unit.pcm.length) this.samples.append(unit.pcm);
      else if (room > 0) this.samples.append(unit.pcm.subarray(0, room));
    }
  }

  // ─── the loop ──────────────────────────────────────────────────────────────────────────────────────────────────

  private tick(): void {
    if (this.ended) return;
    const now = this.parts.clock.nowMs();
    if (this.start === undefined && now - this.openedAt > NO_START_MS) {
      this.endWith(STREAM_CLOSES.protocol);
      return;
    }
    if (this.start !== undefined && now - this.lastUnitAt > SILENT_PHONE_MS) {
      this.endWith(STREAM_CLOSES.silentPhone);
      return;
    }
    if (this.start !== undefined) this.emit();
    if (!this.ended && this.phase !== 'loading') void this.step();
  }

  private async warmUp(): Promise<void> {
    try {
      // One half second of silence loads the models now, so the first word is not what pays for the load.
      await this.call(() => this.parts.engine.detectSpeech(new Float32Array(SECOND / 2)));
      if (this.ended) return;
      this.phase = 'idle';
    } catch (error) {
      this.refuse(this.codeOf(error));
    }
  }

  private async step(): Promise<void> {
    if (this.stepping) return;
    this.stepping = true;
    try {
      if (this.muted) return;
      if (this.phase === 'idle') await this.listen();
      else if (this.phase === 'hearing') await this.hear();
    } catch (error) {
      this.failTurn(this.codeOf(error));
    } finally {
      this.stepping = false;
    }
  }

  /** No turn is open: look at what has arrived for a voice. */
  private async listen(): Promise<void> {
    const length = this.samples.length;
    if (length > BACKLOG_KEEP) this.samples.dropBefore(length - BACKLOG_KEEP);
    const at = this.samples.length;
    if (at < SECOND / 4) return;
    const spans = await this.call(() => this.parts.engine.detectSpeech(this.samples.slice(0, at)));
    this.seenLength = at;
    const first = spans[0];
    if (first === undefined) {
      if (this.samples.length > IDLE_KEEP) this.samples.dropBefore(this.samples.length - IDLE_KEEP);
      return;
    }
    this.turn += 1;
    this.turnStart = Math.max(0, first.start - LEAD_IN);
    this.lastSpeechEnd = spans[spans.length - 1]?.end ?? first.end;
    this.interimAt = 0;
    this.early = undefined;
    this.speculateAfter = 0;
    this.words = undefined;
    this.last = undefined;
    this.phase = 'hearing';
  }

  /** A turn is open: find the end of the voice, and show interim words while the turn is short. */
  private async hear(): Promise<void> {
    const at = this.samples.length;
    // After an early decode the unseen audio is expected, and is scanned in full, so no voice in it is skipped.
    const resume = this.scanFrom;
    this.scanFrom = undefined;
    if (resume === undefined && at - this.seenLength > BEHIND) return this.failTurn('engine_behind');
    const from = Math.max(this.turnStart, Math.min(at - (this.pauseSamples + SECOND), resume ?? at));
    const spans = await this.call(() => this.parts.engine.detectSpeech(this.samples.slice(from, at)));
    this.seenLength = at;
    const last = spans[spans.length - 1];
    if (last !== undefined) this.lastSpeechEnd = Math.max(this.lastSpeechEnd, from + last.end);
    const silence = at - this.lastSpeechEnd;
    const length = at - this.turnStart;
    if (silence >= this.pauseSamples || length >= (TURN_MAX_MS / 1000) * SECOND) {
      await this.finishTurn(Math.min(at, this.lastSpeechEnd + LEAD_IN));
      return;
    }
    const spoken = this.lastSpeechEnd - this.turnStart;
    const cut = this.lastSpeechEnd + LEAD_IN;
    // Interim words and the early decode are best-effort: a busy engine is skipped, never queued, and its time is not
    // unseen audio. Only the final decode (at the pause) can lose the turn.
    if (spoken > INTERIM_MAX || this.parts.clock.nowMs() < this.speculateAfter) return;
    if (silence >= EARLY_SILENCE && !this.isEarly(cut)) {
      const heard = await this.speculate(
        this.samples.slice(this.turnStart, cut),
        this.finalBudget(cut - this.turnStart),
      );
      this.interimAt = spoken;
      if (this.phase !== 'hearing' || heard === undefined) return;
      this.early = { turn: this.turn, cut, text: heard.text };
      this.setWords(heard.text, false);
      return;
    }
    if (spoken - this.interimAt >= INTERIM_EVERY) {
      const heard = await this.speculate(this.samples.slice(this.turnStart, this.lastSpeechEnd), FINAL_BASE_MS);
      this.interimAt = spoken;
      if (this.phase === 'hearing' && heard !== undefined) this.setWords(heard.text, false);
    }
  }

  /**
   * A decode nobody is waiting for yet. Whatever it costs the engine, the VAD then scans every sample that arrived meanwhile
   * (so the pause is heard and no voice is skipped), the unseen audio it left is expected, and the engine is left alone as
   * long as this took. A decode over its budget is no answer rather than a lost turn: the final decode has its own deadline.
   */
  private async speculate(audio: Float32Array, budgetMs: number): Promise<{ readonly text: string } | undefined> {
    const began = this.parts.clock.nowMs();
    try {
      return await this.decodeWithin(audio, budgetMs);
    } catch (error) {
      if (error instanceof StreamTimeout) return undefined;
      throw error;
    } finally {
      const now = this.parts.clock.nowMs();
      this.speculateAfter = now + (now - began);
      this.scanFrom = this.seenLength;
    }
  }

  private async finishTurn(cut: number): Promise<void> {
    this.phase = 'working';
    const turn = this.turn;
    const audio = this.samples.slice(this.turnStart, cut);
    this.samples.dropBefore(cut);
    if (this.samples.length > BACKLOG_KEEP) this.samples.dropBefore(this.samples.length - BACKLOG_KEEP);
    this.seenLength = 0;
    // The decode that began in the pause is this turn's final decode when no voice came back since (same cut).
    const early = this.isEarly(cut) ? this.early : undefined;
    this.early = undefined;
    const heard = early ?? (await this.decodeWithin(audio, this.finalBudget(audio.length)));
    // A phone that died or pressed End during the decode must not send.
    if (this.ended) return;
    // Noise the model wrote as punctuation (".") is not words either.
    const text = heard.text.trim().slice(0, WORDS_MAX_CHARS);
    if (!/[\p{L}\p{N}]/u.test(text)) return this.settle({ turn, outcome: 'dropped', code: 'no_words' });
    // Only an echo of a nonce issued after the decode, just before the send, proves the phone is still there.
    const pausedAfter = this.emitSeq;
    this.setWords(text, true);
    const start = this.start;
    if (start === undefined || start.purpose === 'test') return this.settle({ turn, outcome: 'heard' });
    const proved = await this.proof(pausedAfter);
    if (this.ended) return;
    if (!proved) {
      this.parts.log.info('voice.stream.cancelled', { stream: this.parts.streamId, turn, code: 'phone_silent' });
      return this.settle({ turn, outcome: 'cancelled', code: 'phone_silent' });
    }
    await this.deliver(text, turn);
  }

  private isEarly(cut: number): boolean {
    return this.early?.turn === this.turn && this.early.cut === cut;
  }

  private finalBudget(samples: number): number {
    return FINAL_BASE_MS + ((samples / SECOND) * 1000) / 2;
  }

  private async deliver(text: string, turn: number): Promise<void> {
    // A turn is handed over once. The send id is stable, so even a repeat of this very call would be ONE message.
    const ferretId = this.ferretId;
    if (this.ended || ferretId === undefined || this.sentTurns.has(turn) || this.parts.send === undefined) return;
    // A grant can narrow while the stream is open: it is asked again for every message.
    if (!this.parts.mayChat()) return this.settle({ turn, outcome: 'failed', code: 'fleet_not_granted' });
    this.sentTurns.add(turn);
    const sendId = `${this.parts.streamId}:${turn}`;
    let result: Awaited<ReturnType<NonNullable<StreamParts['send']>>>;
    try {
      result = await this.parts.send(ferretId, `(voice) ${text}`, sendId);
    } catch {
      result = { ok: false, code: 'send_refused' };
    }
    if (!result.ok) return this.settle({ turn, outcome: 'failed', code: result.code });
    this.parts.recordSent(ferretId);
    this.parts.log.info('voice.stream.sent', { stream: this.parts.streamId, turn });
    this.settle({ turn, outcome: 'sent', sendId });
  }

  /** Waits for an echo of a nonce issued after the pause, for at most {@link PROOF_WINDOW_MS}. */
  private async proof(after: number): Promise<boolean> {
    if (this.echoSeq > after) return true;
    return await new Promise<boolean>(resolve => {
      const done = (value: boolean): void => {
        cancel();
        this.wakeProof = undefined;
        resolve(value);
      };
      const cancel = this.parts.clock.after(milliseconds(PROOF_WINDOW_MS), () => done(this.echoSeq > after));
      this.wakeProof = () => {
        if (this.echoSeq > after) done(true);
      };
    });
  }

  private async decodeWithin(audio: Float32Array, budgetMs: number): Promise<{ readonly text: string }> {
    let timer: (() => void) | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = this.parts.clock.after(milliseconds(budgetMs), () => reject(new StreamTimeout()));
    });
    try {
      return await Promise.race([this.call(() => this.parts.engine.transcribe(audio)), late]);
    } finally {
      timer?.();
    }
  }

  /** A load that was superseded (the engine unloaded while this stream waited) is asked again once. */
  private async call<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof VoiceEngineError && error.code === 'not_ready' && !this.ended) return await work();
      throw error;
    }
  }

  private settle(outcome: TurnOutcome): void {
    this.last = outcome;
    this.failures = 0;
    this.phase = 'idle';
  }

  private failTurn(code: string): void {
    if (this.ended) return;
    // A engine that cannot load or has no memory ends the stream: every turn would fail the same way.
    if (code === 'voice_no_memory' || code === 'voice_not_ready' || code === 'engine_failed') {
      this.refuse(code);
      return;
    }
    this.failures += 1;
    this.words = undefined;
    this.samples.dropBefore(this.samples.length);
    this.seenLength = 0;
    this.last = { turn: this.turn, outcome: 'failed', code };
    this.phase = 'idle';
    this.parts.log.info('voice.stream.turn_failed', { stream: this.parts.streamId, turn: this.turn, code });
    if (this.failures >= OVERLOAD_AFTER) this.refuse('engine_overloaded');
  }

  private codeOf(error: unknown): string {
    if (error instanceof StreamTimeout) return 'engine_timeout';
    if (error instanceof VoiceEngineError) {
      if (error.code === 'no_memory') return 'voice_no_memory';
      if (error.code === 'not_ready') return 'voice_not_ready';
      return 'engine_failed';
    }
    return 'engine_failed';
  }

  // ─── downlink ──────────────────────────────────────────────────────────────────────────────────────────────────

  private state(): StreamState {
    if (this.phase === 'loading') return 'loading';
    if (this.muted) return 'muted';
    return this.phase === 'idle' ? 'listening' : this.phase;
  }

  private setWords(text: string, final: boolean): void {
    const rev = (this.words?.rev ?? -1) + 1;
    if (this.words?.text === text && this.words.final === final) return;
    this.words = { turn: this.turn, rev, text: text.slice(0, WORDS_MAX_CHARS), offset: 0, final };
  }

  /** One unit: always parseable alone, always carrying a fresh nonce, with the next piece of the words that fits. */
  private emit(): void {
    if (this.ended) return;
    if (this.parts.downstream.bufferedBytes() > MAX_BUFFERED) {
      this.endWith(STREAM_CLOSES.overloaded);
      return;
    }
    const nonce = this.parts.nonce();
    this.issued.set(nonce, this.emitSeq);
    this.emitSeq += 1;
    if (this.issued.size > ISSUED_KEPT) this.issued.delete(this.issued.keys().next().value as string);
    const base: StreamSnapshot = {
      v: 1,
      state: this.state(),
      nonce,
      turn: this.turn,
      ...(this.last === undefined ? {} : { last: this.last }),
      ...(this.fatal === undefined ? {} : { error: this.fatal }),
    };
    if (this.start?.reply !== 'machine') {
      this.parts.downstream.send(encodeDownlinkUnit(this.withWords(base)));
      return;
    }
    // A stream that asked for the voice always sends the larger unit, with its audio slot filled or zero.
    const sound = this.nextSound();
    const snapshot = this.withWords({
      ...base,
      ...(this.replyState === undefined ? {} : { reply: this.replyState }),
      ...(sound === undefined ? {} : { audio: sound.audio }),
    });
    this.parts.downstream.send(encodeReplyDownlinkUnit(snapshot, sound?.pcm ?? new Int16Array(0)));
  }

  private withWords(base: StreamSnapshot): StreamSnapshot {
    const words = this.words;
    if (words === undefined || words.offset >= words.text.length) return base;
    const fits = (length: number): StreamSnapshot => ({
      ...base,
      words: {
        turn: words.turn,
        rev: words.rev,
        offset: words.offset,
        total: words.text.length,
        text: words.text.slice(words.offset, words.offset + length),
        final: words.final,
      },
    });
    let low = 0;
    let high = words.text.length - words.offset;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (snapshotBytes(fits(middle)) <= DOWNLINK_JSON_MAX_BYTES) low = middle;
      else high = middle - 1;
    }
    // Never cut a surrogate pair in half: the other half would not be valid text on its own.
    const edge = words.text.charCodeAt(words.offset + low - 1);
    if (low > 1 && edge >= 0xd800 && edge <= 0xdbff) low -= 1;
    if (low === 0) return base;
    const chunk = fits(low);
    words.offset += low;
    return chunk;
  }

  // ─── ending ────────────────────────────────────────────────────────────────────────────────────────────────────

  /** A fatal refusal: said once in a unit, then the stream closes. */
  private refuse(code: string): void {
    if (this.ended) return;
    this.fatal = { code, message: sentenceOf(code) };
    this.emit();
    this.endWith(CLOSE_FOR[code] ?? STREAM_CLOSES.failed);
  }

  private endWith(close: { readonly code: number; readonly reason: string }): void {
    if (this.ended) return;
    this.finish();
    this.parts.downstream.close(close.code, close.reason);
  }

  private finish(): void {
    if (this.ended) return;
    this.ended = true;
    for (const cancel of this.cancels.splice(0)) cancel();
    this.wakeProof?.();
    this.releaseFerret?.();
    this.releaseFerret = undefined;
    this.parts.onEnd();
  }
}

/** The final decode did not answer within its budget. */
class StreamTimeout extends Error {}
