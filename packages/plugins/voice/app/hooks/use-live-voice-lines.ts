/**
 * SPEAK WHILE THE FERRET WORKS: the composition point of voice mode's live lines. It joins the pure reader of finished
 * `<voice>` lines (`lib/voice-mode/live-reader.ts`) to the machine's reply voice, which the voice-mode panel offers through
 * the voice-mode store (`LiveSink`). While voice mode is on, each line the ferret finishes is handed to the machine at once;
 * while it is off this does nothing at all and forgets everything, so a later voice mode starts from the rows of that moment.
 *
 * It hands the end-of-turn reading one thing back: `unsaid(markdown)`, what of that text was not played live (the text itself
 * when nothing of it was, the lines not played when some were, nothing when all were), so Auto-read says every line once and
 * a line that failed to play, or was cut off, is still heard.
 */
import { useEffect, useRef } from 'react';
import { createLiveReader, type LiveReader, type LiveRow } from '../lib/voice-mode/live-reader.ts';
import type { LiveSink } from '../lib/voice-mode/live-lines.ts';

export interface LiveVoiceLinesInput {
  /** Voice mode is on for this ferret. */
  readonly active: boolean;
  readonly rows: readonly LiveRow[];
  /** The daemon's live word on whose turn it is (`turn.live`) and the state itself. */
  readonly live: boolean;
  readonly visible: boolean;
  /** The voice-mode panel's machine voice, or `undefined` while there is none (the panel is not up yet, or it went to the phone). */
  readonly sink: () => LiveSink | undefined;
}

export function useLiveVoiceLines(input: LiveVoiceLinesInput): { readonly unsaid: (markdown: string) => string } {
  const reader = useRef<LiveReader | null>(null);
  reader.current ??= createLiveReader();
  const latest = useRef(input);
  latest.current = input;
  const { active, rows, live, visible } = input;

  // The rows and the turn are what say the conversation moved; the sink is read through `latest`.
  useEffect(() => {
    const current = reader.current;
    if (current === null) return;
    if (!active) {
      current.reset();
      return;
    }
    const sink = latest.current.sink();
    const looked = current.observe(rows, { live, visible });
    for (const line of looked.lines) {
      // A voice that cannot take the line leaves it to the reading at the end of the turn. One that can is told what became of it.
      const settled = current.accepted(line.text);
      if (sink?.say(line, settled) !== true) settled('unplayed');
    }
    if (looked.progress.length > 0) sink?.outdate(looked.progress);
  }, [active, rows, live, visible]);

  const unsaid = useRef((markdown: string): string => reader.current?.unsaid(markdown) ?? markdown);
  return { unsaid: unsaid.current };
}
