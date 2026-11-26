/**
 * WHAT THE PERSON HAS HEARD OF A REPLY (V2) AND THE NOTE THAT TELLS THE FERRET WHEN THEY CUT IT OFF (V3).
 *
 * The machine knows every line it was asked to speak and how long each of its pieces turned out to be; only the device
 * knows how much of it reached the person's ears. When the person talks over the reply, the device says where it was
 * (a {@link SpeechCut}: line `id` for `samples` of its sound, every line before it whole) and this turns that position
 * into words. Pieces are exact boundaries; INSIDE a piece the word position is an ESTIMATE (the voice returns no word
 * timings), the fraction of the piece's sound that played times its words, so it is good to about a word or two either
 * way. The note says so to nobody: the instruction (`instructions/voice.md`) tells the ferret.
 *
 * PRIVACY. Words live only in this object, in this stream's memory: never audio, never a log line, never a file. A
 * line that was dropped, or that the machine could not speak (the device reads it itself), is not counted, because
 * what the person heard of it is not known here. Pure, with no clock.
 */
import type { SpeechCut } from '../../../contract/index.ts';
import { splitForSpeech } from '../reply/chunks.ts';

/** The note quotes this many of the last words heard, and this many of the first words not heard. */
const HEARD_WORDS = 12;
const UNHEARD_WORDS = 30;
/** The most lines kept at once (a reply is one to a few lines): the oldest is forgotten past this. */
const LINES_KEPT = 64;

interface Line {
  /** Which line this was to arrive at the stream, so a message forgets only the lines that were there when it left. */
  readonly seq: number;
  readonly pieces: readonly string[];
  /** The sound of each piece made so far, in samples. */
  readonly made: number[];
}

/** The note waiting for the next message: `n` counts the cut-ins of this stream, and is the note's own send id. */
interface Note {
  readonly n: number;
  readonly text: string;
  readonly heard: readonly string[];
  readonly unheard: readonly string[];
}

/**
 * A note taken out of waiting to go to the ferret, by ONE path: carried by the person's next message ({@link Said.carry}) or sent
 * by itself ({@link Said.alone}). Nothing else can pick the same note up until it is given back ({@link Said.failed}).
 */
interface Sending {
  /** The note this send carries, if there was one waiting. */
  readonly note?: Note;
  /** The lines that were here when it left: a send that is answered forgets these and never a line that came after. */
  readonly upTo: number;
}

export interface Said {
  /** A line was accepted to be spoken. */
  line(id: number, text: string): void;
  /** The next piece of the line was made, `samples` long. */
  made(id: number, samples: number): void;
  /** The line is not counted (taken back, or the machine could not speak it): what was heard of it is not known. */
  skip(id: number): void;
  /** The person cut the reply off here. Returns whether a note is now waiting. Forgets the lines. */
  cut(at: SpeechCut): boolean;
  /** The lines are forgotten (the reply was replaced, or the person's next message answered it). */
  clear(): void;
  /** The note waiting for the next message, if any. */
  note(): Note | undefined;
  /**
   * The person's message is about to go: it takes the waiting note, if any, and answers the lines heard so far. Always
   * answered with {@link delivered} or {@link failed}.
   */
  carry(): Sending;
  /** The note waiting is about to go by itself: taken from waiting, with no lines answered. `undefined` when none waits. */
  alone(): (Sending & { readonly note: Note }) | undefined;
  /** The send was acknowledged: its note is spent, and the lines it answered are forgotten (never a line that came after it). */
  delivered(sending: Sending): void;
  /** The send was refused: its note waits again, with whatever was said since, and may go by either path. */
  failed(sending: Sending): void;
}

const wordsOf = (text: string): string[] => text.split(/\s+/u).filter(word => word.length > 0);
const quoted = (words: readonly string[]): string => words.join(' ').replaceAll('"', "'");

/** The note's own text: the shape `instructions/voice.md` teaches. */
export function noteText(heard: readonly string[], unheard: readonly string[]): string {
  const tail = heard.slice(-HEARD_WORDS);
  const head = unheard.slice(0, UNHEARD_WORDS);
  const before = heard.length > HEARD_WORDS ? '… ' : '';
  const after = unheard.length > UNHEARD_WORDS ? ' …' : '';
  const said = tail.length === 0 ? 'nothing' : `"${before}${quoted(tail)}"`;
  return `[heard up to: ${said}; not heard: "${quoted(head)}${after}"]`;
}

/**
 * Walks the lines in order, spending the heard sound: every line before the cut whole, the cut line up to its samples,
 * the rest nothing. A piece that was never made is not heard, and a piece the cut falls inside is split by its share
 * of the sound.
 */
export function splitHeard(
  lines: Iterable<readonly [number, Pick<Line, 'pieces' | 'made'>]>,
  at: SpeechCut,
): { readonly heard: string[]; readonly unheard: string[] } {
  const heard: string[] = [];
  const unheard: string[] = [];
  for (const [id, line] of lines) {
    let budget = id < at.id ? Number.POSITIVE_INFINITY : id === at.id ? at.samples : 0;
    line.pieces.forEach((piece, place) => {
      const words = wordsOf(piece);
      const made = line.made[place];
      if (made === undefined || budget <= 0) unheard.push(...words);
      else if (budget >= made) {
        heard.push(...words);
        budget -= made;
      } else {
        const count = Math.floor((words.length * budget) / made);
        heard.push(...words.slice(0, count));
        unheard.push(...words.slice(count));
        budget = 0;
      }
    });
  }
  return { heard, unheard };
}

export function createSaid(): Said {
  const lines = new Map<number, Line>();
  /** The note waiting to be taken by a send. One in flight is not here: it is held by its send alone. */
  let pending: Note | undefined;
  let cuts = 0;
  let arrived = 0;
  /** A second cut before the ferret was told: what was not heard adds up, and the newer place wins when there is one. */
  const join = (before: Note | undefined, heard: readonly string[], unheard: readonly string[], n: number): Note => {
    const allHeard = heard.length > 0 || before === undefined ? heard : before.heard;
    const allUnheard = [...(before?.unheard ?? []), ...unheard].slice(0, UNHEARD_WORDS + 1);
    return {
      n,
      text: noteText(allHeard, allUnheard),
      heard: allHeard.slice(-(HEARD_WORDS + 1)),
      unheard: allUnheard,
    };
  };
  return {
    line(id, text) {
      arrived += 1;
      lines.set(id, { seq: arrived, pieces: splitForSpeech(text), made: [] });
      if (lines.size > LINES_KEPT) lines.delete(lines.keys().next().value as number);
    },
    made(id, samples) {
      lines.get(id)?.made.push(samples);
    },
    skip(id) {
      lines.delete(id);
    },
    cut(at) {
      const { heard, unheard } = splitHeard(lines, at);
      lines.clear();
      if (unheard.length === 0) return false;
      cuts += 1;
      pending = join(pending, heard, unheard, cuts);
      return true;
    },
    clear() {
      lines.clear();
    },
    note: () => pending,
    carry() {
      const note = pending;
      pending = undefined;
      return { ...(note === undefined ? {} : { note }), upTo: arrived };
    },
    alone() {
      const note = pending;
      pending = undefined;
      return note === undefined ? undefined : { note, upTo: 0 };
    },
    delivered(sending) {
      for (const [id, line] of lines) if (line.seq <= sending.upTo) lines.delete(id);
    },
    failed(sending) {
      if (sending.note === undefined) return;
      pending = pending === undefined ? sending.note : join(sending.note, pending.heard, pending.unheard, pending.n);
    },
  };
}
