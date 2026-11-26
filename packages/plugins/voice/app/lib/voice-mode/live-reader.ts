/**
 * WHICH `<voice>` LINES OF A STREAMING REPLY ARE NEW. Pure and small: a reader over the rows the chat shows, with no clock and
 * no browser object. Each time the rows change it says which spoken lines have just been FINISHED (closing tag written) and
 * were not yet handed on, in order, each with what it is for (`first` of the turn, `progress` while the turn is working, the
 * `result` once it is not).
 *
 * WHAT IT NEVER DOES. It never hands on a line that was already there when it started looking (voice mode switched on in a
 * conversation with history; a cached copy of the rows the daemon has not confirmed), a line of a tab nobody is looking at,
 * or a line still being written (the grammar's `open` line is drawn, never said). Those are consumed in silence, once.
 *
 * `covers` answers one question for the end-of-turn reading: was every spoken line of this text already handed on? Then the
 * reading must not say it a second time.
 */
import { splitVoice } from '@ferretry/plugin-conversation/contract';
import type { LineKind } from './live-lines.ts';

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
  /** The ferret is working on a turn right now (a line that arrives then is progress). */
  readonly working: boolean;
  /** Somebody is looking at the page. A line that finishes while nobody is, is never said. */
  readonly visible: boolean;
}

export interface LiveReader {
  /** Lines finished since the last look, oldest first. */
  observe(rows: readonly LiveRow[], observation: LiveObservation): readonly { text: string; kind: LineKind }[];
  /** The line was taken by the voice: a reading of the same words must not say it again. */
  accepted(text: string): void;
  /** Whether the text has at least one spoken line and every one of them was taken by the voice. */
  covers(markdown: string): boolean;
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

export function createLiveReader(): LiveReader {
  /** Per row: how many closed lines of it were already handled. */
  let consumed = new Map<string, number>();
  let seeded = false;
  let turnKey: string | undefined;
  let linesThisTurn = 0;
  let spoken = new Set<string>();

  return {
    observe(rows, { live, working, visible }) {
      const held = Array.isArray(rows) ? rows : [];
      const lastPerson = held.findLastIndex(isPerson);
      const key = lastPerson === -1 ? '' : (held[lastPerson]?.id ?? '');
      const out: { text: string; kind: LineKind }[] = [];
      // The first look, and any look at a copy the daemon has not confirmed, only learns what is already there.
      const silent = !seeded || !live;
      if (live) seeded = true;
      if (key !== turnKey) {
        turnKey = key;
        linesThisTurn = 0;
        spoken = new Set();
      }
      held.forEach((row, index) => {
        if (!isAssistantWords(row)) return;
        const lines = closedLines(row.text);
        const from = consumed.get(row.id) ?? 0;
        consumed.set(row.id, Math.max(from, lines.length));
        // A row from before the person's last message belongs to an earlier turn: it is never said now.
        if (silent || index < lastPerson || !visible) return;
        for (const text of lines.slice(from)) {
          out.push({ text, kind: linesThisTurn === 0 ? 'first' : working ? 'progress' : 'result' });
          linesThisTurn += 1;
        }
      });
      return out;
    },
    accepted: text => void spoken.add(text),
    covers(markdown) {
      const lines = closedLines(markdown);
      return lines.length > 0 && lines.every(text => spoken.has(text));
    },
    reset() {
      consumed = new Map();
      seeded = false;
      turnKey = undefined;
      linesThisTurn = 0;
      spoken = new Set();
    },
  };
}
