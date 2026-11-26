/**
 * SPEAK WHILE THE FERRET WORKS: the composition point of voice mode's live lines. It joins the pure reader of finished
 * `<voice>` lines (`lib/voice-mode/live-reader.ts`) to the machine's reply voice, which the voice-mode panel offers through
 * the voice-mode store (`LiveSink`). While voice mode is on, each line the ferret finishes is handed to the machine at once;
 * while it is off this does nothing at all and forgets everything, so a later voice mode starts from the rows of that moment.
 *
 * It hands the end-of-turn reading one thing back: `covers(markdown)`, true when every spoken line of that text was already
 * said live, so Auto-read does not say a reply twice.
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
  readonly working: boolean;
  readonly visible: boolean;
  /** The voice-mode panel's machine voice, or `undefined` while there is none (the panel is not up yet, or it went to the phone). */
  readonly sink: () => LiveSink | undefined;
}

export function useLiveVoiceLines(input: LiveVoiceLinesInput): { readonly covers: (markdown: string) => boolean } {
  const reader = useRef<LiveReader | null>(null);
  reader.current ??= createLiveReader();
  const latest = useRef(input);
  latest.current = input;
  const { active, rows, live, working, visible } = input;

  // The rows and the turn are what say the conversation moved; the sink is read through `latest`.
  useEffect(() => {
    const current = reader.current;
    if (current === null) return;
    if (!active) {
      current.reset();
      return;
    }
    const sink = latest.current.sink();
    for (const line of current.observe(rows, { live, working, visible })) {
      // A voice that cannot take the line leaves it to the reading at the end of the turn.
      if (sink?.say(line) === true) current.accepted(line.text);
    }
  }, [active, rows, live, working, visible]);

  const covers = useRef((markdown: string): boolean => reader.current?.covers(markdown) ?? false);
  return { covers: covers.current };
}
