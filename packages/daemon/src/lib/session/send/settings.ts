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
  /** The CLI a receiving agent is told to answer with. The daemon is not a command anyone types. */
  readonly clientName: string;
}

export const SessionSendSettingsSchema = z.object({
  controlLaunchWaitMs: z.number().int().positive(),
  nativeQueueInlineMaxChars: z.number().int().positive(),
  directSendMaxChars: z.number().int().nonnegative(),
  clientName: z.string().min(1),
});

export const defaultSessionSendSettings: SessionSendSettings = {
  controlLaunchWaitMs: 60_000,
  nativeQueueInlineMaxChars: 1_000,
  directSendMaxChars: 500,
  clientName: 'fy',
};

export function parseSessionSendSettings(value: unknown): SessionSendSettings {
  return SessionSendSettingsSchema.parse(value);
}
