/**
 * WHICH `<voice>` LINES OF A STREAMING REPLY ARE NEW. Pure and small: a reader over the rows the chat shows, with no clock and
 * no browser object. Each time the rows change it says which spoken lines have just been FINISHED (closing tag written) and
 * were not yet handed on, in order, each with what it is for (the `first` of the turn, or just a `line`), and which lines are by now
 * KNOWN to be progress. A line is known to be progress only when the ferret went on to use a tool after it (a turn's result is
 * never followed by one): the turn state is no evidence, because the last line of a result is read before the turn says it ended.
 * Whatever is not known to be progress is kept.
 *
 * WHAT IT NEVER DOES. It never hands on a line that was already there when it started looking (voice mode switched on in a
 * conversation with history; a cached copy of the rows the daemon has not confirmed), a line of a tab nobody is looking at,
 * or a line still being written (the grammar's `open` line is drawn, never said). Those are consumed in silence, once.
 *
 * `unsaid` answers one question for the end-of-turn reading: which of this text's spoken lines were not said live? Each line
 * handed on is followed to what became of it: `played` and `dropped` are never read again, `unplayed` (a piece failed, the person
 * talked over it, the stream went away) is read, and a line still being said counts as said.
 */
import { splitVoice } from '@ferretry/plugin-conversation/contract';
import type { LineKind, LineOutcome } from './live-lines.ts';

/** The part of a transcript row this reads: the chat's own rows satisfy it as they are. */
export interface LiveRow {
  readonly id: string;
  readonly kind: string;
  readonly text: string;
  readonly sent?: unknown;
  readonly pack?: unknown;
  readonly peer?: unknown;
}

interface LiveObservation {
  /** The rows are the daemon's live word, not this device's cached copy. */
  readonly live: boolean;
  /** Somebody is looking at the page. A line that finishes while nobody is, is never said. */
  readonly visible: boolean;
}

interface LiveLooked {
  /** Lines finished since the last look, oldest first. */
  readonly lines: readonly { text: string; kind: LineKind }[];
  /** Lines (by their words) that are now known to be progress, once each: the ferret went on working after them. */
  readonly progress: readonly string[];
}

export interface LiveReader {
  observe(rows: readonly LiveRow[], observation: LiveObservation): LiveLooked;
  /**
   * The line was taken by the voice. Returns what to tell the reader when it is settled (played, dropped, or not played);
   * a settlement of an earlier turn's line is ignored.
   */
  accepted(text: string): (outcome: LineOutcome) => void;
  /**
   * What the end-of-turn reading still has to say of this text: the text itself when nothing of it was said live, the
   * lines not yet said (as `<voice>` lines) when some were, and nothing (an empty string) when all of them were.
   */
  unsaid(markdown: string): string;
  /** Starts over (voice mode went off): the next look is a first look. */
  reset(): void;
}

const closedLines = (text: string): readonly string[] =>
  splitVoice(text).flatMap(piece => (piece.kind === 'voice' && !piece.open ? [piece.text] : []));

const isPerson = (row: LiveRow): boolean => row.kind === 'user' && row.peer === undefined;
const isAssistantWords = (row: LiveRow): boolean =>
  row.kind === 'assistant' &&
  row.sent === undefined &&
  row.pack === undefined &&
  row.peer === undefined &&
  typeof row.text === 'string' &&
  row.text.trim() !== '';

/** A later tool call in the turn means the ferret went on working: the words before it were not the end of the turn. */
const isWork = (row: LiveRow): boolean => row.kind === 'tool';

type Said = 'pending' | 'played' | 'dropped';

export function createLiveReader(): LiveReader {
  /** Per row: how many closed lines of it were already handled. */
  let consumed = new Map<string, number>();
  let seeded = false;
  let turnKey: string | undefined;
  let linesThisTurn = 0;
  /** What became of each line handed to the voice this turn, by its words. A line not here was not said. */
  let said = new Map<string, Said>();
  /** Per row, how many of its lines were already reported as progress. */
  let reported = new Map<string, number>();
  /** Bumped when a turn begins or the reader starts over, so a settlement of an earlier line is not taken for this turn's. */
  let epoch = 0;

  return {
    observe(rows, { live, visible }) {
      const held = Array.isArray(rows) ? rows : [];
      const lastPerson = held.findLastIndex(isPerson);
      const key = lastPerson === -1 ? '' : (held[lastPerson]?.id ?? '');
      const out: { text: string; kind: LineKind }[] = [];
      const progress: string[] = [];
      // The first look, and any look at a copy the daemon has not confirmed, only learns what is already there.
      const silent = !seeded || !live;
      if (live) seeded = true;
      if (key !== turnKey) {
        turnKey = key;
        linesThisTurn = 0;
        said = new Map();
        reported = new Map();
        epoch += 1;
      }
      const lastWork = held.findLastIndex(isWork);
      held.forEach((row, index) => {
        if (!isAssistantWords(row)) return;
        const lines = closedLines(row.text);
        const from = consumed.get(row.id) ?? 0;
        consumed.set(row.id, Math.max(from, lines.length));
        // A row from before the person's last message belongs to an earlier turn: it is never said now.
        if (silent || index < lastPerson || !visible) return;
        for (const text of lines.slice(from)) {
          out.push({ text, kind: linesThisTurn === 0 ? 'first' : 'line' });
          linesThisTurn += 1;
        }
        // The ferret used a tool after these words: they were narration, not the end of the turn.
        if (lastWork > index) {
          const before = reported.get(row.id) ?? 0;
          progress.push(...lines.slice(before));
          reported.set(row.id, lines.length);
        }
      });
      return { lines: out, progress };
    },
    accepted(text) {
      said.set(text, 'pending');
      const mine = epoch;
      return outcome => {
        if (mine !== epoch) return;
        if (outcome === 'unplayed') said.delete(text);
        else said.set(text, outcome);
      };
    },
    unsaid(markdown) {
      const lines = closedLines(markdown);
      const owed = lines.filter(text => !said.has(text));
      if (lines.length === 0 || owed.length === lines.length) return markdown;
      return owed.map(text => `<voice>${text}</voice>`).join('\n\n');
    },
    reset() {
      consumed = new Map();
      seeded = false;
      turnKey = undefined;
      linesThisTurn = 0;
      said = new Map();
      reported = new Map();
      epoch += 1;
    },
  };
}
