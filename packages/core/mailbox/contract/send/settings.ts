import { z } from 'zod';

/** Every tunable the send slice owns, injected rather than hard-coded. */
export interface SessionSendSettings {
  /**
   * How long a send queues behind an in-flight FIRST launch before answering "still launching".
   *
   * The same number the revive uses, and for the same reason: a send that lands mid-bootstrap and
   * succeeds anyway would fight the launch for the same composer.
   */
  readonly controlLaunchWaitMs: number;
  /**
   * The payload length above which a native-queue ride writes a file and types a pointer instead.
   *
   * Typing a very long payload into a composer that is already mid-turn is where the harness drops
   * characters; a pointer is one line whatever the payload weighs.
   */
  readonly nativeQueueInlineMaxChars: number;
  /**
   * The default ceiling on typing a payload VERBATIM into an idle composer, when the session's own
   * configuration does not state one.
   */
  readonly directSendMaxChars: number;
  /**
   * The ceiling on typing a MULTI-LINE payload into an idle composer as one bracketed paste, for a
   * harness whose composer is proven to take one (Claude Code). A session's own `directSendMaxChars`
   * still bounds it from above, and `0` there still opts the session out of every direct send.
   *
   * Sized to a peer message: a banner plus a typical report is 500–1,200 characters, and anything past
   * this travels as a turn file the receiver reads, which costs it one more model call.
   */
  readonly directPasteMaxChars: number;
  /**
   * How long releasing held sends waits for Codex to end a startup park before leaving them held.
   *
   * Codex ends the park itself within about fifteen seconds (its account round trip times out) or exits, so
   * this is forty times that, not a tuned figure: a pane still parked after it is wedged, and its sends stay held for the revive that replaces it (the release is journalled as deferred).
   */
  readonly startupParkWaitMs: number;
  /** How often that wait looks at the pane again. */
  readonly startupParkPollMs: number;
  /** The CLI a receiving agent is told to answer with. The daemon is not a command anyone types. */
  readonly clientName: string;
}

const SessionSendSettingsSchema = z.object({
  controlLaunchWaitMs: z.number().int().positive(),
  nativeQueueInlineMaxChars: z.number().int().positive(),
  directSendMaxChars: z.number().int().nonnegative(),
  directPasteMaxChars: z.number().int().positive(),
  startupParkWaitMs: z.number().int().positive(),
  startupParkPollMs: z.number().int().positive(),
  clientName: z.string().min(1),
});

export const defaultSessionSendSettings: SessionSendSettings = {
  controlLaunchWaitMs: 60_000,
  nativeQueueInlineMaxChars: 1_000,
  directSendMaxChars: 500,
  directPasteMaxChars: 2_000,
  startupParkWaitMs: 600_000,
  startupParkPollMs: 2_000,
  clientName: 'fy',
};

export function parseSessionSendSettings(value: unknown): SessionSendSettings {
  return SessionSendSettingsSchema.parse(value);
}
